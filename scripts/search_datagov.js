// 搜尋 data.gov.tw 資料集
const q = process.argv[2];
const url = 'https://data.gov.tw/api/front/dataset/list?qs=' + encodeURIComponent(q) + '&page=0&size=20';
fetch(url, { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0' } })
  .then(r => r.json())
  .then(d => {
    console.log('count:', d.payload.search_count);
    for (const x of d.payload.search_result) console.log(x.nid, '|', x.title, '|', x.agency_name);
  })
  .catch(e => console.error('ERR', e.message));
