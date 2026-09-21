const API = "https://fenix.tecnico.ulisboa.pt/api/fenix/v1";
const ID = process.argv[2] ?? "2448131360897";

const resposta = await fetch(`${API}/spaces/${ID}`);
if (!resposta.ok) throw new Error(`Erro ${resposta.status}`);
const dados = await resposta.json();

console.log(dados.type, "-", dados.name);

for (const espaco of dados.containedSpaces ?? []) {
  console.log(espaco.type, espaco.id, espaco.name);
}

if (dados.type === "ROOM") {
  console.log("Capacidade:", dados.capacity);
  for (const ev of dados.events ?? []) {
    console.log(ev.period.start, "->", ev.period.end, ev.type);
  }
}