// Recolhe os horários das salas do Fénix, semana a semana.
//
// Uso:
//   node recolher.mjs                     esta semana, nos 3 campi
//   node recolher.mjs --semanas=4         esta semana e as 3 seguintes
//   node recolher.mjs --dia=28/09/2026    a semana que contém essa data
//   node recolher.mjs --refazer           volta a percorrer todos os edifícios
//   node recolher.mjs ID1 ID2             só estes espaços (campus, edifício...)
//
// Ficheiros criados:
//   salas.json                lista de salas (edifício, piso, capacidade)
//   semanas/AAAA-MM-DD.json   aulas de uma semana (a data é a segunda-feira)
//   indice.json               lista das semanas disponíveis

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

const API = process.env.FENIX_API ?? "https://fenix.tecnico.ulisboa.pt/api/fenix/v1";
const CAMPI = ["2448131360897", "2448131360898", "2448131392438"]; // Alameda, Taguspark, Tecnológico e Nuclear

const PARALELOS = 4; // quantos pedidos ao mesmo tempo
const PAUSA_MS = 100; // pausa entre pedidos de cada "trabalhador"

// --- Ler o que foi escrito no terminal ---------------------------------
const args = process.argv.slice(2);
const opcao = (nome) => args.find((a) => a.startsWith(`--${nome}=`))?.slice(nome.length + 3);
const refazer = args.includes("--refazer");
const numSemanas = Number(opcao("semanas") ?? 1);
const ids = args.filter((a) => !a.startsWith("--"));
if (ids.length === 0) ids.push(...CAMPI);

if (!Number.isInteger(numSemanas) || numSemanas < 1) {
  console.log("--semanas tem de ser um número inteiro, por exemplo --semanas=4");
  process.exit(1);
}

// --- Datas ---------------------------------------------------------------
const pad = (n) => String(n).padStart(2, "0");
const paraISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // 2026-09-21
const paraFenix = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; // 21/09/2026

function lerDia(texto) {
  const partes = texto.split("/").map(Number);
  if (partes.length !== 3 || partes.some(Number.isNaN)) {
    console.log(`Data inválida: "${texto}". Usa o formato dd/mm/aaaa, por exemplo --dia=28/09/2026`);
    process.exit(1);
  }
  const [dd, mm, aaaa] = partes;
  return new Date(aaaa, mm - 1, dd, 12); // meio-dia evita problemas com a mudança de hora
}

function segundaDe(data) {
  const segunda = new Date(data);
  segunda.setDate(segunda.getDate() - ((segunda.getDay() + 6) % 7));
  return segunda;
}

const base = opcao("dia") ? lerDia(opcao("dia")) : new Date();
base.setHours(12, 0, 0, 0);
const primeiraSegunda = segundaDe(base);
const segundas = Array.from({ length: numSemanas }, (_, i) => {
  const s = new Date(primeiraSegunda);
  s.setDate(s.getDate() + 7 * i);
  return s;
});

// "22/09/2026 10:00" -> "2026-09-22T10:00"
function textoParaISO(texto) {
  const [data, hora] = texto.split(" ");
  const [dd, mm, aaaa] = data.split("/");
  return `${aaaa}-${mm}-${dd}T${hora}`;
}

// --- Pedidos ao Fénix ------------------------------------------------------
const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pedir(id, segunda, tentativas = 3) {
  const url = new URL(`${API}/spaces/${id}`);
  url.searchParams.set("day", paraFenix(segunda));

  for (let i = 1; i <= tentativas; i++) {
    try {
      const resposta = await fetch(url);
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      return await resposta.json();
    } catch (erro) {
      if (i === tentativas) throw erro;
      await espera(500 * i);
    }
  }
}

function converterEventos(lista) {
  return (lista ?? [])
    .map((ev) => ({
      inicio: textoParaISO(ev.period.start),
      fim: textoParaISO(ev.period.end),
      tipo: ev.type,
      nome: ev.course?.acronym ?? ev.title ?? "",
    }))
    .sort((a, b) => a.inicio.localeCompare(b.inicio));
}

// --- Fila com vários trabalhadores em paralelo -------------------------------
const erros = []; // { onde, id, erro }

async function correrFila(fila, onde, processar) {
  let emCurso = 0;
  let feitos = 0;

  async function trabalhador() {
    while (true) {
      const item = fila.shift();

      if (item === undefined) {
        // Fila vazia: se mais ninguém está a trabalhar, acabou; senão espera
        if (emCurso === 0) return;
        await espera(50);
        continue;
      }

      emCurso++;
      try {
        await processar(item);
      } catch (erro) {
        erros.push({ onde, id: item.id, erro: erro.message });
      } finally {
        emCurso--;
        feitos++;
      }

      process.stdout.write(`\r${onde}: ${feitos} feitos | ${fila.length} por fazer   `);
      await espera(PAUSA_MS);
    }
  }

  await Promise.all(Array.from({ length: PARALELOS }, trabalhador));
  process.stdout.write("\n");
}

// --- Aulas de cada semana: chave "2026-09-21" -> { idSala: [eventos] } ------
const eventosPorSemana = new Map(segundas.map((s) => [paraISO(s), {}]));

// Percorre campus -> edifícios -> pisos -> salas. Devolve a lista de salas.
async function percorrerArvore() {
  const salas = [];
  let ignoradas = 0;
  const segunda = segundas[0];
  const eventosDaSemana = eventosPorSemana.get(paraISO(segunda));
  const fila = ids.map((id) => ({ id, contexto: {} }));

  await correrFila(fila, "Edifícios e salas", async (item) => {
    const espaco = await pedir(item.id, segunda);
    const contexto = { ...item.contexto };

    if (espaco.type === "CAMPUS") contexto.campus = espaco.name;
    if (espaco.type === "BUILDING") contexto.edificio = espaco.name;
    if (espaco.type === "FLOOR") contexto.piso = espaco.name;

    if (espaco.type === "ROOM") {
      const eventos = converterEventos(espaco.events);
      const temCapacidade = espaco.capacity && espaco.capacity.normal > 0;

      if (temCapacidade || eventos.length > 0) {
        salas.push({
          id: espaco.id,
          nome: espaco.name.trim(),
          campus: contexto.campus ?? "",
          edificio: contexto.edificio ?? "",
          piso: contexto.piso ?? "",
          capacidade: espaco.capacity?.normal ?? null,
        });
        if (eventos.length > 0) eventosDaSemana[espaco.id] = eventos;
      } else {
        ignoradas++; // corredores, escadas, instalações sanitárias, etc.
      }
    }

    for (const filho of espaco.containedSpaces ?? []) {
      fila.push({ id: filho.id, contexto });
    }
  });

  return { salas, ignoradas };
}

// Pede só as salas já conhecidas, para uma semana
async function recolherSemana(salas, segunda) {
  const chave = paraISO(segunda);
  const eventosDaSemana = eventosPorSemana.get(chave);
  const fila = salas.map((s) => ({ id: s.id }));

  await correrFila(fila, `Semana de ${chave}`, async (item) => {
    const espaco = await pedir(item.id, segunda);
    const eventos = converterEventos(espaco.events);
    if (eventos.length > 0) eventosDaSemana[item.id] = eventos;
  });
}

async function lerJSON(caminho) {
  try {
    return JSON.parse(await readFile(caminho, "utf8"));
  } catch {
    return null;
  }
}

// Falhas de uma semana (a primeira semana falha durante a recolha dos edifícios)
const falhasDaSemana = (chave) =>
  erros.filter(
    (e) => e.onde === `Semana de ${chave}` || (chave === paraISO(segundas[0]) && e.onde === "Edifícios e salas")
  ).length;

const mesmosIds = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// --- Correr tudo -------------------------------------------------------------
console.log(`Semanas: ${segundas.map(paraISO).join(", ")}`);

let salas;
let semanasPorFazer;
let ignoradas = null;
let refezLista = false;

const guardadas = refazer ? null : await lerJSON("salas.json");
if (guardadas && mesmosIds(guardadas.origem, ids)) {
  salas = guardadas.salas;
  semanasPorFazer = segundas;
  console.log(`A usar o salas.json que já existe (${salas.length} salas). Usa --refazer para percorrer os edifícios outra vez.`);
  if (guardadas.falhas > 0) {
    console.log(`Atenção: quando foi criado, ${guardadas.falhas} pedidos falharam, por isso podem faltar salas. Usa --refazer para tentar outra vez.`);
  }
} else {
  const resultado = await percorrerArvore();
  if (resultado.salas.length === 0) {
    console.log(`\nNão consegui recolher nenhuma sala (${erros.length} pedidos falharam). Verifica a ligação. Nada foi alterado.`);
    process.exit(1);
  }
  salas = resultado.salas;
  ignoradas = resultado.ignoradas;
  refezLista = true;
  semanasPorFazer = segundas.slice(1); // a primeira semana já veio com a árvore
  await writeFile(
    "salas.json",
    JSON.stringify({ geradoEm: new Date().toISOString(), origem: ids, falhas: erros.length, salas })
  );
}

for (const segunda of semanasPorFazer) {
  await recolherSemana(salas, segunda);
}

// --- Gravar as semanas ----------------------------------------------------------
await mkdir("semanas", { recursive: true });
console.log("");
for (const segunda of segundas) {
  const chave = paraISO(segunda);
  const eventos = eventosPorSemana.get(chave);
  const total = Object.values(eventos).reduce((soma, lista) => soma + lista.length, 0);
  const falhas = falhasDaSemana(chave);

  if (total === 0) {
    console.log(
      falhas > 0
        ? `Semana de ${chave}: ${falhas} pedidos falharam e não há dados, nada foi guardado. Verifica a ligação e volta a correr.`
        : `Semana de ${chave}: nenhuma aula encontrada, não foi guardada (o Fénix pode ainda não ter estes horários).`
    );
    continue;
  }

  await writeFile(
    `semanas/${chave}.json`,
    JSON.stringify({ segunda: chave, geradoEm: new Date().toISOString(), eventos })
  );
  console.log(
    `Semana de ${chave}: ${total} eventos em ${Object.keys(eventos).length} salas` +
      (falhas > 0 ? ` (${falhas} pedidos falharam: essas salas aparecem livres nesta semana)` : "")
  );
}

const ficheiros = (await readdir("semanas"))
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map((f) => f.slice(0, 10))
  .sort();
await writeFile("indice.json", JSON.stringify({ semanas: ficheiros }));

console.log(`\nSalas: ${salas.length}`);
if (ignoradas !== null) console.log(`Espaços ignorados (sem capacidade nem aulas): ${ignoradas}`);
console.log(`Semanas disponíveis: ${ficheiros.join(", ") || "nenhuma"}`);

const recolhidas = segundas.map(paraISO);
const outras = ficheiros.filter((f) => !recolhidas.includes(f));
if (refezLista && outras.length > 0) {
  console.log(
    `\nAtenção: refizeste a lista de salas, por isso as semanas ${outras.join(", ")} podem ficar sem algumas salas. ` +
      `Volta a recolhê-las com --dia=...`
  );
}

if (erros.length > 0) {
  console.log(`\nPedidos que falharam: ${erros.length}`);
  for (const e of erros.slice(0, 10)) console.log(` - ${e.onde}, ${e.id}: ${e.erro}`);
  console.log("Se forem muitos, volta a correr o comando.");
}
