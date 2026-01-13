const LOCALES=[
  {hl:'de', gl:'DE', ceid:'DE:de'},
  {hl:'de', gl:'AT', ceid:'AT:de'},
  {hl:'de', gl:'CH', ceid:'CH:de'}
];
const make = (l) => `https://news.google.com/rss/search?q=%22Peter+Fintl%22&hl=${l.hl}&gl=${l.gl}&ceid=${l.ceid}`;
console.log(LOCALES.map(make).join('\n'));
