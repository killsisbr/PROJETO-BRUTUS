const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class MensagensService {
    constructor() {
        this.db = null;
        this.dbPath = path.join(__dirname, '../../data/mensagens.sqlite');
    }

    async init() {
        try {
            // Criar diretório se não existir
            const dataDir = path.dirname(this.dbPath);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            this.db = new Database(this.dbPath);
            
            // Criar tabelas
            this.createTables();
            
            // Migrar mensagens existentes se necessário
            await this.migrateExistingMessages();
            
            console.log('[MENSAGENS] Serviço inicializado com sucesso');
            return true;
        } catch (error) {
            console.error('[MENSAGENS] Erro ao inicializar:', error);
            return false;
        }
    }

    createTables() {
        // Tabela de mensagens
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS mensagens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chave TEXT UNIQUE NOT NULL,
                titulo TEXT NOT NULL,
                conteudo TEXT NOT NULL,
                tipo TEXT DEFAULT 'sistema',
                ativo BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de gatilhos
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS gatilhos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nome TEXT NOT NULL,
                palavras_chave TEXT NOT NULL,
                resposta TEXT NOT NULL,
                tipo TEXT DEFAULT 'personalizado',
                ativo BOOLEAN DEFAULT 1,
                prioridade INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Índices para performance
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_mensagens_chave ON mensagens(chave);
            CREATE INDEX IF NOT EXISTS idx_mensagens_ativo ON mensagens(ativo);
            CREATE INDEX IF NOT EXISTS idx_gatilhos_ativo ON gatilhos(ativo);
            CREATE INDEX IF NOT EXISTS idx_gatilhos_prioridade ON gatilhos(prioridade);
        `);
    }

    async migrateExistingMessages() {
        const existingCount = this.db.prepare('SELECT COUNT(*) as count FROM mensagens').get().count;
        
        if (existingCount > 0) {
            console.log('[MENSAGENS] Mensagens já migradas');
            return;
        }

        console.log('[MENSAGENS] Inicializando mensagens padrão...');
        
        // Adicionar alguns gatilhos padrão
        this.addDefaultTriggers();
    }

    formatTitle(chave) {
        const titles = {
            'msgAjuda': 'Mensagem de Ajuda',
            'msgApresentação': 'Mensagem de Apresentação',
            'msgAvisoEntrega': 'Aviso de Entrega',
            'msgEntregaeTaxas': 'Entrega e Taxas',
            'msgFormaDePagamento': 'Forma de Pagamento',
            'msgMenuGlobal': 'Menu Global',
            'msgObservação': 'Observações',
            'msgPedindoEndereço': 'Pedindo Endereço',
            'msgPedindoNome': 'Pedindo Nome',
            'msgPosPedido': 'Pós Pedido',
            'msgRecebido': 'Pedido Recebido',
            'msgTroco': 'Informações de Troco'
        };
        return titles[chave] || chave;
    }

    addDefaultTriggers() {
        const defaultTriggers = [
            {
                nome: 'Saudação',
                palavras_chave: 'oi,olá,ola,bom dia,boa tarde,boa noite',
                resposta: 'Olá! Bem-vindo ao Brutus Burger! 🍔\n\nComo posso ajudá-lo hoje?',
                tipo: 'saudacao',
                prioridade: 1
            },
            {
                nome: 'Horário de Funcionamento',
                palavras_chave: 'horario,funcionamento,aberto,fechado,que horas',
                resposta: '🕐 *Horário de Funcionamento:*\n▪️ Segunda a Domingo: 18:00 às 23:30',
                tipo: 'informacao',
                prioridade: 2
            },
            {
                nome: 'Localização',
                palavras_chave: 'endereço,endereco,onde,localização,localizacao',
                resposta: '📍 *Nossa Localização:*\nInforme seu endereço que verificamos se entregamos na sua região!',
                tipo: 'informacao',
                prioridade: 2
            },
            {
                nome: 'Cardápio',
                palavras_chave: 'cardapio,menu,o que tem,produtos',
                resposta: '🍔 *Nosso Cardápio:*\nTemos deliciosos hambúrguers, bebidas e acompanhamentos!\n\nDigite o nome do produto que deseja ou navegue pelo nosso menu.',
                tipo: 'cardapio',
                prioridade: 2
            }
        ];

        for (const trigger of defaultTriggers) {
            try {
                this.addGatilho(trigger);
            } catch (error) {
                // Ignorar se já existir
            }
        }
    }

    // CRUD Mensagens
    getAllMensagens() {
        return this.db.prepare('SELECT * FROM mensagens ORDER BY titulo').all();
    }

    getMensagemByChave(chave) {
        if (!this.db) {
            console.log('[MENSAGENS] Banco não inicializado, retornando null para chave:', chave);
            return null;
        }
        return this.db.prepare('SELECT * FROM mensagens WHERE chave = ?').get(chave);
    }

    addMensagem(data) {
        const stmt = this.db.prepare(`
            INSERT INTO mensagens (chave, titulo, conteudo, tipo, ativo)
            VALUES (?, ?, ?, ?, ?)
        `);
        // Se ativo não for especificado ou for true, define como 1 (ativo)
        const ativo = data.ativo === false ? 0 : 1;
        return stmt.run(data.chave, data.titulo, data.conteudo, data.tipo || 'personalizado', ativo);
    }

    updateMensagem(id, data) {
        const stmt = this.db.prepare(`
            UPDATE mensagens 
            SET titulo = ?, conteudo = ?, tipo = ?, ativo = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        // Se ativo não for especificado, mantém como ativo (1)
        // Se for especificado como false, define como inativo (0)
        const ativo = data.ativo === false ? 0 : 1;
        return stmt.run(data.titulo, data.conteudo, data.tipo, ativo, id);
    }

    deleteMensagem(id) {
        return this.db.prepare('DELETE FROM mensagens WHERE id = ?').run(id);
    }

    // CRUD Gatilhos
    getAllGatilhos() {
        return this.db.prepare('SELECT * FROM gatilhos ORDER BY prioridade, nome').all();
    }

    getGatilhosAtivos() {
        return this.db.prepare('SELECT * FROM gatilhos WHERE ativo = 1 ORDER BY prioridade, nome').all();
    }

    addGatilho(data) {
        const stmt = this.db.prepare(`
            INSERT INTO gatilhos (nome, palavras_chave, resposta, tipo, ativo, prioridade)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        return stmt.run(
            data.nome, 
            data.palavras_chave, 
            data.resposta, 
            data.tipo || 'personalizado', 
            data.ativo !== false ? 1 : 0,
            data.prioridade || 1
        );
    }

    updateGatilho(id, data) {
        const stmt = this.db.prepare(`
            UPDATE gatilhos 
            SET nome = ?, palavras_chave = ?, resposta = ?, tipo = ?, ativo = ?, prioridade = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        return stmt.run(data.nome, data.palavras_chave, data.resposta, data.tipo, data.ativo ? 1 : 0, data.prioridade, id);
    }

    deleteGatilho(id) {
        return this.db.prepare('DELETE FROM gatilhos WHERE id = ?').run(id);
    }

    // Buscar gatilho por mensagem
    findGatilhoForMessage(message) {
        const gatilhos = this.getGatilhosAtivos();
        const messageNormalized = message.toLowerCase().trim();

        for (const gatilho of gatilhos) {
            const palavras = gatilho.palavras_chave.split(',').map(p => p.trim().toLowerCase());
            
            for (const palavra of palavras) {
                if (messageNormalized.includes(palavra)) {
                    return gatilho;
                }
            }
        }

        return null;
    }

    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

module.exports = new MensagensService();