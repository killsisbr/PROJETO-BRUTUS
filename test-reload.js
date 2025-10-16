// Simular o comportamento do frontend ao recarregar a página
async function simulatePageReload() {
  console.log('Simulando reload da página...');
  
  try {
    // Simular a função loadMenuItems do brutus.html
    console.log('\n--- Testando carregamento do cardápio (brutus.html) ---');
    const response = await fetch('http://localhost:3000/api/cardapio', {
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
    
    const data = await response.json();
    if (data.success) {
      console.log(`✓ Carregados ${data.items.length} itens do cardápio:`);
      data.items.forEach((item, index) => {
        console.log(`  ${index + 1}. ${item.name} - R$ ${item.price}`);
      });
    } else {
      console.log('✗ Erro ao carregar cardápio');
    }
    
    // Simular a função loadProducts do brutusadmin.html
    console.log('\n--- Testando carregamento dos produtos (brutusadmin.html) ---');
    const adminResponse = await fetch('http://localhost:3000/api/cardapio', {
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
    
    const adminData = await adminResponse.json();
    if (adminData.success) {
      console.log(`✓ Carregados ${adminData.items.length} produtos:`);
      adminData.items.forEach((item, index) => {
        console.log(`  ${index + 1}. ${item.name} - R$ ${item.price}`);
      });
    } else {
      console.log('✗ Erro ao carregar produtos');
    }
    
    console.log('\n--- Verificação concluída ---');
    console.log('Se ambos mostram os mesmos itens, o problema de reload foi resolvido.');
    
  } catch (error) {
    console.error('Erro na simulação:', error);
  }
}

simulatePageReload();