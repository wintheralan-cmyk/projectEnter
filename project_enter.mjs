import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import OpenAI from "openai";
import { PDFParse } from 'pdf-parse';

const client = new OpenAI({
  apiKey: process.argv[3]
});

// Caminho do arquivo JSON com labels e keywords
const labelsPath = path.resolve("./schemata.json");

// Função para carregar as labels existentes
function loadLabels() {
  if (!fs.existsSync(labelsPath)) return [];
  return JSON.parse(fs.readFileSync(labelsPath, "utf8"));
}

// Função para salvar labels atualizadas
function saveLabels(labels) {
  fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 2), "utf8");
}

// Função para classificar com base nas keywords, ignorando acentuação e caixa
function classifyDocument(text, labels) {
  const lowerText = text.toLowerCase();
  for (const labelObj of labels) {
    const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const match = labelObj.keywords.every(k => normalize(text).includes(normalize(k)));
    if (match) return labelObj.label;
  }
  return "Desconhecido";
}

// Função para gerar nova label, schema e regras
async function gerarNovaLabel(text) {
  console.log("🔍 Gerando nova label e regras via GPT-5-mini...");

  const prompt = `
Crie uma nova label para o texto abaixo, extraindo palavras-chave, schema descritivo e regras de extração (em código JavaScript pronto para uso).  
Saída obrigatoriamente em JSON no formato:

{
  "label": "nome_label_em_snake_case",
  "keywords": ["palavra1", "palavra2"], // até 3 palavras-chave únicas que identifiquem este tipo de documento
  "extraction_schema": {
    "campo1": "descrição do campo1",
    "campo2": "descrição do campo2"
  },
  "extract_rules": {
    "campo1": "código JS para extrair campo1 da variável text",
    "campo2": "código JS para extrair campo2 da variável text"
  }
}

Texto:
${text}

Retorne **apenas** o JSON.`;

  const resposta = await client.responses.create({
    model: "gpt-5-mini",
    input: prompt
  });
  //Caso necessário, controle de uso da IA
  //console.log("Tokens usados:", resposta.usage);

  //limpeza da resposta caso não venha em JSON puro
  const conteudo =
      resposta.output_text ||
      resposta.output?.[0]?.content?.[0]?.text ||
      resposta.choices?.[0]?.message?.content ||
      JSON.stringify(resposta);
  const conteudoLimpo = conteudo
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
  try {
    const json = JSON.parse(conteudoLimpo);
    return json;
  } catch (e) {
    console.error("Erro ao interpretar resposta da IA:", conteudo);
    return null;
  }
}

// Função para aplicar regras de extração existentes
function extrairDadosComRegras(text, extractRules) {
  const resultado = {};
  for (const [campo, codigo] of Object.entries(extractRules)) {
    try {
      resultado[campo] = eval(codigo);
    } catch (e) {
      resultado[campo] = null;
    }
  }
  return resultado;
}

// Função principal
async function processarDocumento(pdfObj) {
  const labels = loadLabels();
  const text = pdfObj.content;
  let label = classifyDocument(text, labels);
  console.log(`📄 Documento ${pdfObj.pdf_path} → Label: ${label}`);

  // Se desconhecido, gerar nova label e salvar
  if (label === "Desconhecido") {
    const nova = await gerarNovaLabel(text);
    if (nova) {
      labels.push(nova);
      saveLabels(labels);
      console.log("✅ Nova label criada e salva:", nova.label);
      label = nova.label;
    }
  }

  // Pega label para extração
  const labelObj = labels.find(l => l.label === label);
  let dados = {};
  if (labelObj && labelObj.extract_rules) {
    dados = extrairDadosComRegras(text, labelObj.extract_rules);
  }

  return { label, dados };
}

// Função para ler todos os PDFs da pasta
async function readPdfsFromFolder(folderPath) {
  // Lê todos os arquivos da pasta
  const files = await fsp.readdir(folderPath);

  // Filtra apenas os PDFs
  const pdfFiles = files.filter(f => path.extname(f).toLowerCase() === ".pdf");

  const results = [];

  // Loop nos PDFs
  for (const filename of pdfFiles) {
    try {
        const parser = new PDFParse({ url: path.join(folderPath, filename) });
        const data = await parser.getText();
        results.push({
            pdf_path: filename,
            content: (data.text || '').trim()
        });
    } catch (err) {
            console.warn(`Erro ao ler ${filename}: ${err.message}`);
    }
  }

  return results;
}

// Recebe a pasta como variável externa e chama a função para ler os arquivos
const folder = process.argv[2]
const pdfs = await readPdfsFromFolder(folder);

// Função para salvar novo resultado sem apagar os anteriores
const resultadosPath = path.resolve("./resultados.json");
async function salvarResultado(novoResultado) {
  try {
    // Verifica se o arquivo já existe
    let resultados = [];

    if (fs.existsSync(resultadosPath)) {
      const conteudo = await fsp.readFile(resultadosPath, "utf8");
      if (conteudo.trim()) {
        resultados = JSON.parse(conteudo);
      }
    }

    // Adiciona o novo resultado
    resultados.push(novoResultado);

    // Salva de volta no arquivo (com identação bonita)
    await fsp.writeFile(resultadosPath, JSON.stringify(resultados, null, 2), "utf8");
    console.log("✅ Resultado salvo em resultados.json");
  } catch (err) {
    console.error("❌ Erro ao salvar resultado:", err);
  }
}

(async () => {
  for (const doc of pdfs) {
    //Teste se o conteúdo dos .pdfs veio corretamente e controle do tempo de operação
    //console.log(JSON.stringify(doc, null, 2));
    //console.time("execução_doc");
    const resultado = await processarDocumento(doc);
    //resultado final salvo em 'resultados.json'
    //console.log(JSON.stringify(resultado.dados, null, 2));
    await salvarResultado(resultado.dados);
    //console.timeEnd("execução_doc");
  }
})();