'use strict';
const locales=require('../../i18n/locales.json');
const files=['web','web-extra','web-dynamic','web-tail'];
const reviewed=require('../../i18n/reviewed.json');
function load(){const catalog={};for(const name of files)for(const [key,entry]of Object.entries(require('../../i18n/'+name+'.json'))){if(catalog[key]&&catalog[key].source!==entry.source)throw Error('Conflicting message key '+key);catalog[key]={...catalog[key],...entry,...reviewed[key]};}return catalog;}
const tokens=value=>[...value.matchAll(/\{\{[^}]+\}\}/g)].map(x=>x[0]).sort().join('|');
function validate(catalog){const failures=[];for(const [key,entry]of Object.entries(catalog))for(const {code}of locales){const value=entry[code];if(typeof value!=='string'||!value.trim())failures.push(key+': missing '+code);else if(tokens(value)!==tokens(entry.source)||/ZXQ(?:ARG|ROW)/.test(value))failures.push(key+': invalid parameters '+code);}if(failures.length)throw Error(failures.length+' catalog errors:\n'+failures.slice(0,20).join('\n'));}
module.exports={load,validate,tokens};
