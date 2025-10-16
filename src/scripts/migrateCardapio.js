const path = require('path');
const fs = require('fs');
const cardapioService = require('../services/cardapioService');
const { normalizarTexto, encontrarMelhorMatch } = require('../utils/normalizarTexto');

async function migrate(options = {}) {
  await cardapioService.init();
  const added = { items: 0, mappings: 0 };

  // try to load maps if present
  let mapaLanches = null;
  let mapaBebidas = null;
  try { mapaLanches = require(path.join('..','..','src','utils','mapaLanches.js')); } catch(e) { /* ignore */ }
  try { mapaBebidas = require(path.join('..','..','src','utils','mapaBebidas.js')); } catch(e) { /* ignore */ }

  const normalizeName = (s) => String(s||'').trim();

  // helper: ensure item exists by name; return id
  function findItemIdByName(items, nome) {
    if (!nome || !Array.isArray(items)) return null;
    
    const nomeNormalizado = normalizarTexto(nome);
    if (!nomeNormalizado) return null;
    
    // Primeiro: busca exata
    for (const item of items) {
      if (normalizarTexto(item.nome) === nomeNormalizado) {
        return item.id;
      }
    }
    
    // Segundo: busca por melhor match usando especificidade
    const mapeamentoItens = {};
    items.forEach(item => {
      const chaveNormalizada = normalizarTexto(item.nome);
      if (chaveNormalizada) {
        mapeamentoItens[chaveNormalizada] = item.id;
      }
    });
    
    const melhorMatch = encontrarMelhorMatch(nome, mapeamentoItens);
    return melhorMatch ? melhorMatch.valor : null;
  }

  try {
    // load existing items
    let items = cardapioService.getItems() || [];

    const addItemIfMissing = (nome, tipo = 'Lanche') => {
      const n = normalizeName(nome);
      if (!n) return null;
      const exists = findItemIdByName(items, n);
      if (exists) return exists;
      const newId = cardapioService.addItem({ nome: n, descricao: '', preco: 0, tipo });
      if (newId) {
        added.items++;
        items = cardapioService.getItems(); // refresh
      }
      return newId;
    };

    // process bebidas
    if (mapaBebidas && typeof mapaBebidas === 'object') {
      for (const [nome, id] of Object.entries(mapaBebidas)) {
        // ensure target item exists (we don't know name->target item name, but use the mapped id as source id if exists in items)
        // If item with that id exists already, skip creating duplicate. If not found, create a generic item with that mapped id as name hint
        const itemsNow = cardapioService.getItems();
        const found = itemsNow.find(it => Number(it.id) === Number(id));
        let targetId = null;
        if (found) targetId = found.id;
        else {
          // create a placeholder with name = nome (first occurrence)
          targetId = addItemIfMissing(nome, 'Bebida');
        }
        if (targetId) {
          const ok = cardapioService.addMapping(nome, targetId);
          if (ok) added.mappings++;
        }
      }
    }

    // process lanches
    if (mapaLanches && typeof mapaLanches === 'object') {
      for (const [nome, id] of Object.entries(mapaLanches)) {
        const itemsNow = cardapioService.getItems();
        const found = itemsNow.find(it => Number(it.id) === Number(id));
        let targetId = null;
        if (found) targetId = found.id;
        else {
          targetId = addItemIfMissing(nome, 'Lanche');
        }
        if (targetId) {
          const ok = cardapioService.addMapping(nome, targetId);
          if (ok) added.mappings++;
        }
      }
    }

    // optionally process mapaNumeros? no, skip

  } catch (e) {
    console.error('[migrateCardapio] erro', e);
  }

  console.log('[migrateCardapio] resultados', added);
  return added;
}

module.exports = migrate;
