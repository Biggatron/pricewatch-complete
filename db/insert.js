const query = require('./db');

async function main() {
  try {
    await query(
        'INSERT INTO track (orig_price, curr_price, requires_javascript, price_url, price_div, product_name, user_id, email, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
        [ 3990, 3990, true, 'https://blush.is/product/uberlube', ',17,6\.1 C17,9\.5,14\.3,12\.3,10\.9,12\.3z M10\.9,2\.2C8\.7,2\.2,7,4,7,6\.1s1\.8,3\.9,3\.9,3\.9c2\.2,0,3\.9\-1\.7,3\.9\-3\.9C14\.8,4,13,2\.2,10\.9,2\.2z"><\/path><\/g><\/svg><\/label><\/div><div class="site\-header\-notification"><p>Frí sending af pöntunum fyrir 15\.000 kr\. og yfir!<\/p><\/div><\/div><div class="main" style="min\-height: calc\(\-85px \+ 100vh\);"><div class="product\-hero "><div class="product\-hero\-title"><h2>Uberlube<\/h2><h1 class="">Uberlube<\/h1><\/div><div class="product\-hero\-badge"><b class="product\-hero\-badge\-price">(.*?)<\/b><\/div><\/div><div class="product\-frame "><div class="product\-content"><div class="product\-excerpt "><div class="product\-excerpt\-body"><p>Uberlube er hágæða sleipiefni sem inniheldur aðeins náttúruleg efni\. Sleipiefnið er silíkonblandað sem gefur því silkimjúka áferð og góða endingu\. Uberlube hefur aðeins fjögur innihaldsefni sem gerir það eitt af hreinustu sleipiefnunum á markaðnum\. Það er lyktarlaust og inniheldur engin skaðleg efni eins og paraben eða ilmefni\. Uberlube er frábær viðbót í ky', 'Uberlube', 1, 'birgir.snorrason@gmail.com', true ]
    );
    console.info('Data successfully added');
  } catch (e) {
    console.error('Error adding data to SQL tables:', e.message);
  }
}

main().catch((err) => {
    console.error(err);
  });