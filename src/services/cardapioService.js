const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { normalizarTexto } = require('../utils/normalizarTexto');

const DB_FILE = path.join(__dirname, '..', '..', 'data', 'cardapio.sqlite');

let SQL = null;
let db = null;
let ready = null;

async function init() {
  if (ready) return ready;
  ready = (async () => {
    SQL = await initSqlJs({ locateFile: file => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm') });
    // load or create DB
    if (fs.existsSync(DB_FILE)) {
      const buf = fs.readFileSync(DB_FILE);
      db = new SQL.Database(new Uint8Array(buf));
    } else {
      db = new SQL.Database();
      db.run(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, descricao TEXT, preco REAL, tipo TEXT);
                 CREATE TABLE IF NOT EXISTS mappings (nome TEXT PRIMARY KEY, itemId INTEGER);`);
      persist();
    }
    return true;
  })();
  return ready;
}

function persist() {
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, buffer);
  } catch (e) {
    console.error('[cardapioService] erro ao persistir DB', e);
  }
}

function getItems() {
  if (!db) return [];
  try {
    const res = db.exec("SELECT id, nome, descricao, preco, tipo FROM items ORDER BY nome COLLATE NOCASE ASC;");
    if (!res || !res[0]) return [];
    const cols = res[0].columns;
    return res[0].values.map(r => {
      const out = {};
      for (let i = 0; i < cols.length; i++) out[cols[i]] = r[i];
      return out;
    });
  } catch (e) { console.error('[cardapioService] getItems error', e); return []; }
}

function addItem({ nome, descricao, preco, tipo, id }) {
  if (!db) return null;
  try {
    const stmt = db.prepare('INSERT INTO items (nome, descricao, preco, tipo) VALUES (:nome, :descricao, :preco, :tipo)');
    stmt.run({ ':nome': String(nome||''), ':descricao': String(descricao||''), ':preco': Number(preco||0), ':tipo': String(tipo||'Lanche') });
    stmt.free && stmt.free();
    // get last id
    const last = db.exec('SELECT last_insert_rowid() AS id;');
    const insertedId = (last && last[0] && last[0].values && last[0].values[0]) ? last[0].values[0][0] : null;
    persist();
    return insertedId;
  } catch (e) { console.error('[cardapioService] addItem error', e); return null; }
}

function removeItem(itemId) {
  if (!db) return false;
  try {
    // Primeiro, remover todos os mapeamentos de gatilho para este item
    const mappingStmt = db.prepare('DELETE FROM mappings WHERE itemId = :itemId');
    mappingStmt.run({ ':itemId': Number(itemId) });
    mappingStmt.free && mappingStmt.free();
    
    // Depois, remover o item do cardápio
    const itemStmt = db.prepare('DELETE FROM items WHERE id = :id');
    itemStmt.run({ ':id': Number(itemId) });
    itemStmt.free && itemStmt.free();
    
    persist();
    return true;
  } catch (e) { console.error('[cardapioService] removeItem error', e); return false; }
}

function updateItem(itemId, { nome, descricao, preco, tipo }) {
  if (!db) return false;
  try {
    const stmt = db.prepare('UPDATE items SET nome = :nome, descricao = :descricao, preco = :preco, tipo = :tipo WHERE id = :id');
    stmt.run({ 
      ':id': Number(itemId),
      ':nome': String(nome||''), 
      ':descricao': String(descricao||''), 
      ':preco': Number(preco||0), 
      ':tipo': String(tipo||'Lanche') 
    });
    stmt.free && stmt.free();
    persist();
    return true;
  } catch (e) { console.error('[cardapioService] updateItem error', e); return false; }
}

function getMappings() {
  if (!db) return {};
  try {
    const res = db.exec('SELECT nome, itemId FROM mappings;');
    if (!res || !res[0]) return {};
    const out = {};
    for (const row of res[0].values) {
      out[normalizarTexto(String(row[0]))] = Number(row[1]);
    }
    return out;
  } catch (e) { console.error('[cardapioService] getMappings error', e); return {}; }
}

function addMapping(nome, itemId) {
  if (!db) return false;
  try {
    const n = normalizarTexto(String(nome||''));
    const stmt = db.prepare('INSERT OR REPLACE INTO mappings (nome, itemId) VALUES (:nome, :itemId)');
    stmt.run({ ':nome': n, ':itemId': Number(itemId) });
    stmt.free && stmt.free();
    persist();
    return true;
  } catch (e) { console.error('[cardapioService] addMapping error', e); return false; }
}

function addMultipleMappings(gatilhos, itemId) {
  if (!db || !Array.isArray(gatilhos)) return false;
  try {
    const stmt = db.prepare('INSERT OR REPLACE INTO mappings (nome, itemId) VALUES (:nome, :itemId)');
    const gatilhosNormalizados = new Set();
    let gatilhosAdicionados = 0;
    let gatilhosDuplicados = 0;
    
    for (const gatilho of gatilhos) {
      const n = normalizarTexto(String(gatilho||''));
      if (n) {
        if (gatilhosNormalizados.has(n)) {
          gatilhosDuplicados++;
          // console.log(`[cardapioService] Gatilho duplicado normalizado: "${gatilho}" → "${n}"`);
        } else {
          gatilhosNormalizados.add(n);
          stmt.run({ ':nome': n, ':itemId': Number(itemId) });
          gatilhosAdicionados++;
        }
      }
    }
    stmt.free && stmt.free();
    persist();
    
    if (gatilhosDuplicados > 0) {
      console.log(`[cardapioService] addMultipleMappings: ${gatilhosAdicionados} únicos adicionados, ${gatilhosDuplicados} duplicados ignorados (Item ${itemId})`);
    }
    
    return true;
  } catch (e) { console.error('[cardapioService] addMultipleMappings error', e); return false; }
}

function getMappingsByItemId(itemId) {
  if (!db) return [];
  try {
    const res = db.exec('SELECT nome FROM mappings WHERE itemId = ?', [Number(itemId)]);
    if (!res || !res[0]) return [];
    return res[0].values.map(row => String(row[0]));
  } catch (e) { console.error('[cardapioService] getMappingsByItemId error', e); return []; }
}

function removeMapping(nome) {
  if (!db) return false;
  try {
    const n = normalizarTexto(String(nome||''));
    const stmt = db.prepare('DELETE FROM mappings WHERE nome = :nome');
    stmt.run({ ':nome': n });
    stmt.free && stmt.free();
    persist();
    return true;
  } catch (e) { console.error('[cardapioService] removeMapping error', e); return false; }
}

function clearAllMappings() {
  if (!db) return false;
  try {
    const stmt = db.prepare('DELETE FROM mappings');
    const result = stmt.run();
    stmt.free && stmt.free();
    persist();
    console.log('[cardapioService] clearAllMappings: removed', result.changes || 0, 'mappings');
    return true;
  } catch (e) { console.error('[cardapioService] clearAllMappings error', e); return false; }
}

module.exports = {
  init,
  ready: () => ready,
  getItems,
  addItem,
  removeItem,
  updateItem,
  getMappings,
  addMapping,
  addMultipleMappings,
  getMappingsByItemId,
  removeMapping,
  clearAllMappings,
};
