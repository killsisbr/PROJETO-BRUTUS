const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const os = require('os');

let db;

// Inicializa o SQL.js
async function initDatabase() {
    const SQL = await initSqlJs();
    const caminhoBanco = path.join(pastaDadosApp, 'clientes.db');
    
    try {
        if (fs.existsSync(caminhoBanco)) {
            const filebuffer = fs.readFileSync(caminhoBanco);
            db = new SQL.Database(filebuffer);
        } else {
            db = new SQL.Database();
        }
        console.log(`[INFO] Conectado ao banco de dados SQLite em: ${caminhoBanco}`);
        createBanco();
    } catch (err) {
        console.error('Erro ao inicializar banco:', err);
        db = new SQL.Database(); // Cria um banco em memória como fallback
        createBanco();
    }
}

// Salva o banco no arquivo
function saveDatabase() {
    try {
        const caminhoBanco = path.join(pastaDadosApp, 'clientes.db');
        const data = db.export();
        fs.writeFileSync(caminhoBanco, data);
    } catch (err) {
        console.error('Erro ao salvar banco:', err);
    }
}

const NOME_APP = "brutusbot";

// Função para obter o caminho da pasta de dados do aplicativo de acordo com o SO
function getAppDataPath() {
    switch (process.platform) {
        case 'darwin':
            return path.join(os.homedir(), 'Library', 'Application Support', NOME_APP);
        case 'win32':
            return path.join(process.env.APPDATA, NOME_APP);
        case 'linux':
            return path.join(os.homedir(), '.config', NOME_APP);
        default:
            return path.join('.', NOME_APP);
    }
}

const pastaDadosApp = getAppDataPath();
// Cria a pasta de dados do aplicativo se ela não existir
if (!fs.existsSync(pastaDadosApp)) {
    fs.mkdirSync(pastaDadosApp, { recursive: true });
    console.log(`[INFO] Pasta criada para dados do aplicativo: ${pastaDadosApp}`);
}

// Retorna endereço salvo (formato async/await compatível)
function buscarEnderecoCliente(numero) {
    try {
        if (!db) {
            console.error('Banco de dados não inicializado.');
            return Promise.resolve(null);
        }
        const stmt = db.prepare('SELECT endereco, latitude AS lat, longitude AS lng FROM clientes WHERE numero = ?');
        const result = stmt.getAsObject([numero]);
        stmt.free();
        return Promise.resolve(Object.keys(result).length > 0 ? result : null);
    } catch (err) {
        console.error('Erro ao buscar endereço do cliente:', err.message);
        return Promise.resolve(null);
    }
}


const caminhoBanco = path.join(pastaDadosApp, 'clientes.db');


// 👉 Cria a tabela 'clientes' se ela não existir, incluindo colunas para latitude e longitude
function createBanco() {
    try {
        if (!db) {
            console.error('Banco de dados não inicializado ainda.');
            return;
        }
        db.run(`CREATE TABLE IF NOT EXISTS clientes (
            numero TEXT PRIMARY KEY,
            nome TEXT,
            endereco TEXT,
            latitude REAL,
            longitude REAL
        )`);
        // Migrar/garantir colunas adicionais: total_gasto, historico (JSON)
        try { db.run("ALTER TABLE clientes ADD COLUMN total_gasto REAL DEFAULT 0"); } catch(e) { /* coluna já existe */ }
        try { db.run("ALTER TABLE clientes ADD COLUMN historico TEXT DEFAULT '[]'"); } catch(e) { /* coluna já existe */ }
        console.log('[INFO] Tabela "clientes" verificada/criada com sucesso.');
        // Cria tabela de pedidos para histórico e cálculos futuros
        try {
            db.run(`CREATE TABLE IF NOT EXISTS pedidos (
                id TEXT PRIMARY KEY,
                numero TEXT,
                ts INTEGER,
                total REAL,
                entrega INTEGER,
                endereco TEXT,
                estado TEXT,
                items TEXT,
                raw_json TEXT
            )`);
            // Adicionar coluna valorEntrega se não existir
            try { db.run("ALTER TABLE pedidos ADD COLUMN valorEntrega REAL DEFAULT 0"); } catch(e) { /* coluna já existe */ }
            console.log('[INFO] Tabela "pedidos" verificada/criada com sucesso.');
        } catch (e) { console.error('Erro ao criar/verificar tabela pedidos:', e); }
        saveDatabase();
    } catch (err) {
        console.error('Erro ao criar a tabela clientes:', err.message);
    }
}

// Adiciona um pedido ao banco de dados (tabela pedidos) e atualiza histórico/total do cliente
function adicionarPedido(numero, pedido) {
    try {
        if (!db) { console.error('Banco não inicializado'); return; }
        const id = pedido.id || `${String(numero)}_${Date.now()}`;
        const ts = pedido.ts || Date.now();
        const total = Number(pedido.total || 0);
        const entrega = pedido.entrega ? 1 : 0;
        const endereco = pedido.endereco || null;
        const estado = pedido.estado || null;
        const itemsStr = JSON.stringify(pedido.items || []);
        const raw = JSON.stringify(pedido || {});
        
        // Extrair valorEntrega do pedido
        let valorEntrega = 0;
        if (pedido.valorEntrega && typeof pedido.valorEntrega === 'number') {
            valorEntrega = Number(pedido.valorEntrega);
        } else if (entrega && pedido.items && pedido.total) {
            // Calcular valorEntrega baseado na diferença entre total e soma dos itens
            const items = Array.isArray(pedido.items) ? pedido.items : [];
            let totalItens = 0;
            for (const item of items) {
                totalItens += (Number(item.preco) || 0) * (Number(item.quantidade) || 1);
            }
            valorEntrega = total - totalItens;
            if (valorEntrega < 0) valorEntrega = 0;
        }

        const stmt = db.prepare('INSERT OR REPLACE INTO pedidos (id, numero, ts, total, entrega, endereco, estado, items, raw_json, valorEntrega) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        stmt.run([id, numero, ts, total, entrega, endereco, estado, itemsStr, raw, valorEntrega]);
        stmt.free();
        // Atualiza total gasto e histórico do cliente para facilitar consultas agregadas
        try { adicionarGasto(numero, total); } catch(e) {}
        try { adicionarHistorico(numero, { type: 'pedido', id, ts, total }); } catch(e) {}
        saveDatabase();
        console.log(`[INFO] Pedido salvo no banco: ${id} (cliente: ${numero}, total: ${total}, valorEntrega: ${valorEntrega})`);
        return id;
    } catch (err) {
        console.error('Erro ao adicionar pedido:', err.message);
        return null;
    }
}

function obterPedidosPorCliente(numero) {
    try {
        if (!db) return [];
        const stmt = db.prepare('SELECT * FROM pedidos WHERE numero = ? ORDER BY ts DESC');
        const results = [];
        const rows = stmt.getAsObject ? [stmt.getAsObject([numero])] : null; // fallback
        // sql.js doesn't provide an easy iterator on prepared stmt for arbitrary selects, so use run + export
        // Simpler approach: run a query and iterate using exec
        const execRes = db.exec('SELECT * FROM pedidos WHERE numero = "' + String(numero) + '" ORDER BY ts DESC');
        if (execRes && execRes.length > 0) {
            const cols = execRes[0].columns;
            for (const r of execRes[0].values) {
                const obj = {};
                for (let i = 0; i < cols.length; i++) obj[cols[i]] = r[i];
                results.push(obj);
            }
        }
        return results;
    } catch (err) { console.error('Erro ao obter pedidos por cliente:', err); return []; }
}

// Retorna pedidos filtrados por estado (string) ou todos se estado for null
function obterPedidosPorEstado(estado) {
    try {
        if (!db) return [];
        let q = 'SELECT * FROM pedidos';
        if (estado && String(estado).trim().length > 0) {
            q += ' WHERE estado = "' + String(estado).replace(/"/g, '""') + '"';
        }
        q += ' ORDER BY ts DESC';
        const execRes = db.exec(q);
        const results = [];
        if (execRes && execRes.length > 0) {
            const cols = execRes[0].columns;
            for (const r of execRes[0].values) {
                const obj = {};
                for (let i = 0; i < cols.length; i++) obj[cols[i]] = r[i];
                try { if (obj.items && typeof obj.items === 'string') obj.items = JSON.parse(obj.items); } catch(e) {}
                try { if (obj.raw_json && typeof obj.raw_json === 'string') obj.raw_json = JSON.parse(obj.raw_json); } catch(e) {}
                results.push(obj);
            }
        }
        return results;
    } catch (err) { console.error('Erro ao obter pedidos por estado:', err); return []; }
}

// Atualiza o estado de um pedido específico
function atualizarEstadoPedido(pedidoId, novoEstado) {
    try {
        if (!db) {
            console.error('Banco de dados não inicializado');
            return false;
        }
        
        console.log(`Atualizando pedido ${pedidoId} para estado: ${novoEstado}`);
        
        // Primeiro, verificar se o pedido existe
        const checkStmt = db.prepare('SELECT id FROM pedidos WHERE id = ? OR numero = ? OR id LIKE ?');
        const existing = checkStmt.getAsObject([pedidoId, pedidoId, pedidoId + '%']);
        checkStmt.free();
        
        if (Object.keys(existing).length === 0) {
            console.log(`❌ Nenhum pedido encontrado com ID: ${pedidoId}`);
            return false;
        }
        
        // Atualizar o estado do pedido usando sql.js syntax
        const updateQuery = 'UPDATE pedidos SET estado = ? WHERE id = ? OR numero = ? OR id LIKE ?';
        const stmt = db.prepare(updateQuery);
        stmt.run([novoEstado, pedidoId, pedidoId, pedidoId + '%']);
        stmt.free();
        
        console.log(`✅ Pedido(s) atualizado(s) para estado: ${novoEstado}`);
        saveDatabase();
        return true;
        
    } catch (err) {
        console.error('Erro ao atualizar estado do pedido:', err);
        return false;
    }
}

// Reseta apenas os pedidos do dia atual
function resetarPedidosDia() {
    try {
        if (!db) {
            console.error('Banco de dados não inicializado');
            return false;
        }
        
        // Data de hoje
        const hoje = new Date();
        const inicioHoje = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()).getTime();
        const fimHoje = inicioHoje + (24 * 60 * 60 * 1000) - 1;
        
        console.log(`Removendo pedidos entre ${new Date(inicioHoje).toLocaleString()} e ${new Date(fimHoje).toLocaleString()}`);
        
        // Deletar pedidos do dia atual
        const stmt = db.prepare('DELETE FROM pedidos WHERE ts >= ? AND ts <= ?');
        stmt.run([inicioHoje, fimHoje]);
        stmt.free();
        
        console.log('✅ Pedidos do dia foram removidos.');
        
        // Salvar mudanças
        saveDatabase();
        console.log('✅ Banco de dados salvo.');
        
        return true;
        
    } catch (err) {
        console.error('Erro ao resetar pedidos do dia:', err);
        return false;
    }
}

// Reseta todos os pedidos do banco de dados
function resetarPedidos() {
    try {
        if (!db) {
            console.error('Banco de dados não inicializado');
            return false;
        }
        
        // Contar pedidos antes
        const pedidosAntes = obterPedidosPorEstado(null);
        console.log(`Pedidos encontrados antes do reset: ${pedidosAntes.length}`);
        
        // Deletar todos os pedidos
        db.run('DELETE FROM pedidos');
        console.log('✅ Todos os pedidos foram removidos da tabela.');
        
        // Salvar mudanças
        saveDatabase();
        console.log('✅ Banco de dados salvo.');
        
        // Verificar se foi resetado
        const pedidosDepois = obterPedidosPorEstado(null);
        console.log(`Pedidos encontrados após o reset: ${pedidosDepois.length}`);
        
        return pedidosDepois.length === 0;
    } catch (err) {
        console.error('Erro ao resetar pedidos:', err);
        return false;
    }
}

// Retorna um pedido específico pelo id (ou null se não encontrado)
function obterPedidoPorId(id) {
    try {
        if (!db) return null;
        const stmt = db.prepare('SELECT * FROM pedidos WHERE id = ?');
        const row = stmt.getAsObject([id]);
        stmt.free();
        if (row && Object.keys(row).length > 0) {
            // items e raw_json são strings, tentar parse
            try { if (row.items && typeof row.items === 'string') row.items = JSON.parse(row.items); } catch(e) { /* ignore */ }
            try { if (row.raw_json && typeof row.raw_json === 'string') row.raw_json = JSON.parse(row.raw_json); } catch(e) { /* ignore */ }
            return row;
        }
        return null;
    } catch (err) { console.error('Erro ao obter pedido por id:', err); return null; }
}

// Retorna um pedido pelo seu ID (string ID da tabela pedidos)
function obterPedidoPorId(id) {
    try {
        if (!db) return null;
        const execRes = db.exec('SELECT * FROM pedidos WHERE id = "' + String(id).replace(/"/g, '""') + '" LIMIT 1');
        if (execRes && execRes.length > 0) {
            const cols = execRes[0].columns;
            const vals = execRes[0].values[0];
            const obj = {};
            for (let i = 0; i < cols.length; i++) obj[cols[i]] = vals[i];
            // try parsing items/raw_json
            try { if (obj.items && typeof obj.items === 'string') obj.items = JSON.parse(obj.items); } catch(e) { /* ignore */ }
            try { if (obj.raw_json && typeof obj.raw_json === 'string') obj.raw_json = JSON.parse(obj.raw_json); } catch(e) { /* ignore */ }
            return obj;
        }
        return null;
    } catch (err) { console.error('Erro ao obter pedido por id:', err); return null; }
}

/**
 * Retorna todos os clientes do banco de dados
 * @returns {Array} Lista de todos os clientes
 */
function obterTodosClientes() {
    try {
        if (!db) {
            console.error('Banco de dados não inicializado.');
            return [];
        }
        
        const stmt = db.prepare('SELECT * FROM clientes');
        const clientes = [];
        
        while (stmt.step()) {
            const cliente = stmt.getAsObject();
            // Converter coordenadas para números, se existirem
            if (cliente.latitude !== null) {
                cliente.latitude = parseFloat(cliente.latitude);
            }
            if (cliente.longitude !== null) {
                cliente.longitude = parseFloat(cliente.longitude);
            }
            clientes.push(cliente);
        }
        
        stmt.free();
        return clientes;
    } catch (err) {
        console.error('Erro ao obter todos os clientes:', err.message);
        return [];
    }
}

// 👉 Atualiza o endereço, latitude e longitude de um cliente existente
function atualizarEnderecoCliente(numero, novoEndereco, lat = null, lng = null) {
    try {
        if (!db) {
            console.error('Banco de dados não inicializado.');
            return;
        }
        const stmt = db.prepare('UPDATE clientes SET endereco = ?, latitude = ?, longitude = ? WHERE numero = ?');
        const result = stmt.run([novoEndereco, lat, lng, numero]);
        stmt.free();
        
        if (result.changes > 0) {
            console.log(`Endereço e localização do cliente ${numero} atualizados.`);
        } else {
            console.log(`Nenhuma alteração feita para o cliente ${numero}. Verifique se o número existe.`);
        }
        saveDatabase();
    } catch (err) {
        console.error('Erro ao atualizar endereço do cliente:', err.message);
    }
}

/**
 * Atualiza as informações de um cliente existente
 * @param {string} numero - Número do cliente
 * @param {object} dados - Dados a serem atualizados { nome, endereco, lat, lng }
 * @returns {boolean} true se atualizado com sucesso, false caso contrário
 */
function atualizarCliente(numero, dados) {
    try {
        if (!db) {
            console.error('Banco de dados não inicializado.');
            return false;
        }
        
        const { nome, endereco, lat, lng } = dados;
        
        const stmt = db.prepare('UPDATE clientes SET nome = ?, endereco = ?, latitude = ?, longitude = ? WHERE numero = ?');
        const result = stmt.run([nome, endereco, lat, lng, numero]);
        stmt.free();
        
        if (result.changes > 0) {
            console.log(`Cliente ${numero} atualizado com sucesso.`);
            saveDatabase(); // Salvar as alterações
            return true;
        } else {
            console.log(`Nenhuma alteração feita para o cliente ${numero}.`);
            return false;
        }
    } catch (err) {
        console.error('Erro ao atualizar cliente:', err.message);
        return false;
    }
}

// 👉 Atualiza o nome de um cliente existente
function atualizarNomeCliente(numero, novoNome) {
    try {
        if (!db) {
            console.error('Banco de dados não inicializado.');
            return;
        }
        const stmt = db.prepare('UPDATE clientes SET nome = ? WHERE numero = ?');
        const result = stmt.run([novoNome, numero]);
        stmt.free();
        
        if (result.changes > 0) {
            console.log(`Nome do cliente ${numero} atualizado com sucesso.`);
        } else {
            console.log(`Nenhuma alteração de nome feita para o cliente ${numero}. Verifique se o número existe.`);
        }
        saveDatabase();
    } catch (err) {
        console.error('Erro ao atualizar nome do cliente:', err.message);
    }
}

// 👉 Adiciona um novo cliente (ou substitui se já existir) com nome, endereço e coordenadas opcionais
function adicionarCliente(numero, nome, endereco = null, lat = null, lng = null) {
    try {
        if (!db) {
            console.error('Banco de dados não inicializado.');
            return;
        }
        const stmt = db.prepare('INSERT OR REPLACE INTO clientes (numero, nome, endereco, latitude, longitude, total_gasto, historico) VALUES (?, ?, ?, ?, ?, COALESCE((SELECT total_gasto FROM clientes WHERE numero = ?), 0), COALESCE((SELECT historico FROM clientes WHERE numero = ?), "[]"))');
        stmt.run([numero, nome, endereco, lat, lng, numero, numero]);
        stmt.free();
        console.log(`Cliente ${numero} salvo/atualizado com sucesso.`);
        saveDatabase();
    } catch (err) {
        console.error('Erro ao adicionar/atualizar cliente:', err.message);
    }
}

// Adiciona um registro ao histórico JSON do cliente (adiciona objeto/linha)
function adicionarHistorico(numero, entrada) {
    try {
        if (!db) { console.error('Banco não inicializado'); return; }
        const stmt = db.prepare('SELECT historico FROM clientes WHERE numero = ?');
        const row = stmt.getAsObject([numero]);
        stmt.free();
        let hist = [];
        if (row && row.historico) {
            try { hist = JSON.parse(row.historico); } catch(e) { hist = []; }
        }
        hist.push({ ts: Date.now(), entry: entrada });
        const hstr = JSON.stringify(hist);
        // Se o cliente existe, atualiza; caso contrário, insere um novo registro mínimo
        try {
            const u = db.prepare('UPDATE clientes SET historico = ? WHERE numero = ?');
            const res = u.run([hstr, numero]);
            u.free();
            if (!res || res.changes === 0) {
                const ins = db.prepare('INSERT OR REPLACE INTO clientes (numero, historico, total_gasto) VALUES (?, ?, 0)');
                ins.run([numero, hstr]);
                ins.free();
            }
            saveDatabase();
        } catch (e) { console.error('Erro ao gravar historico:', e); }
    } catch (err) { console.error('Erro em adicionarHistorico:', err); }
}

// Adiciona um valor ao total gasto do cliente
function adicionarGasto(numero, valor) {
    try {
        if (!db) { console.error('Banco não inicializado'); return; }
        const u = db.prepare('UPDATE clientes SET total_gasto = COALESCE(total_gasto,0) + ? WHERE numero = ?');
        const res = u.run([Number(valor)||0, numero]);
        u.free();
        if (!res || res.changes === 0) {
            // cliente não existe ainda, insere
            const ins = db.prepare('INSERT OR REPLACE INTO clientes (numero, total_gasto, historico) VALUES (?, ?, "[]")');
            ins.run([numero, Number(valor)||0]);
            ins.free();
        }
        saveDatabase();
    } catch (err) { console.error('Erro ao adicionar gasto:', err); }
}

// Retorna o histórico (array) do cliente
function obterHistoricoCliente(numero) {
    try {
        if (!db) return null;
        const stmt = db.prepare('SELECT historico FROM clientes WHERE numero = ?');
        const row = stmt.getAsObject([numero]);
        stmt.free();
        if (row && row.historico) {
            try { return JSON.parse(row.historico); } catch (e) { return []; }
        }
        return [];
    } catch (err) { console.error('Erro ao obter historico:', err); return null; }
}

// Retorna total gasto do cliente
function obterTotalGasto(numero) {
    try {
        if (!db) return 0;
        const stmt = db.prepare('SELECT total_gasto FROM clientes WHERE numero = ?');
        const row = stmt.getAsObject([numero]);
        stmt.free();
        return row && row.total_gasto ? Number(row.total_gasto) : 0;
    } catch (err) { console.error('Erro ao obter total gasto:', err); return 0; }
}

// 👉 Busca informações de um cliente pelo número, com latitude/longitude convertidas
function obterInformacoesCliente(numero, callback) {
    try {
        if (!db) {
            console.error('Banco de dados não inicializado.');
            if (typeof callback === 'function') return callback(null, null);
            return null;
        }

        const stmt = db.prepare('SELECT * FROM clientes WHERE numero = ?');
        const result = stmt.getAsObject([numero]);
        stmt.free();

        if (Object.keys(result).length > 0) {
            const info = {
                nome: result.nome,
                endereco: result.endereco,
                lat: result.latitude !== null ? parseFloat(result.latitude) : null,
                lng: result.longitude !== null ? parseFloat(result.longitude) : null
            };

            if (typeof callback === 'function') {
                return callback(null, info);
            }

            return info;
        } else {
            if (typeof callback === 'function') return callback(null, null);
            return null;
        }
    } catch (err) {
        if (typeof callback === 'function') return callback(err, null);
        // rethrow so caller can catch if they expect synchronous behavior
        throw err;
    }
}


// 👉 Lista todos os clientes (para debug)
function printarClientes() {
    try {
        if (!db) {
            console.error('Banco de dados não inicializado.');
            return;
        }
        const stmt = db.prepare('SELECT * FROM clientes');
        const rows = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        stmt.free();
        
        if (rows.length === 0) {
            console.log('[INFO] Nenhuns clientes encontrados no banco de dados.');
        } else {
            console.log('[INFO] Lista de Clientes:');
            console.table(rows);
        }
    } catch (err) {
        console.error('Erro ao listar clientes:', err);
    }
}

// Exporta as funções para serem usadas em outros módulos
module.exports = {
    atualizarEnderecoCliente,
    adicionarCliente,
    atualizarNomeCliente,
    obterInformacoesCliente,
    createBanco,
    printarClientes,
    buscarEnderecoCliente,
    caminhoBanco,
    initDatabase,
    adicionarHistorico,
    adicionarGasto,
    obterHistoricoCliente,
    obterTotalGasto,
    obterTodosClientes,
    atualizarCliente
};

// Exports adicionais (adicionarPedido/obterPedidosPorCliente)
module.exports.adicionarPedido = adicionarPedido;
module.exports.obterPedidosPorCliente = obterPedidosPorCliente;
module.exports.obterPedidoPorId = obterPedidoPorId;
module.exports.obterPedidosPorEstado = obterPedidosPorEstado;
module.exports.resetarPedidos = resetarPedidos;
module.exports.resetarPedidosDia = resetarPedidosDia;
module.exports.atualizarEstadoPedido = atualizarEstadoPedido;

// Inicializa o banco de dados e exporta a Promise para que outros módulos possam aguardar
const dbInitPromise = initDatabase();
dbInitPromise.catch(err => {
    console.error('Erro ao inicializar banco de dados:', err);
});

// Exporta a promise para uso externo
module.exports.dbReady = dbInitPromise;
