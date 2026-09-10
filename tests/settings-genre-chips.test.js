'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../public/js/pages/Settings.js'),'utf8');
const start=source.indexOf('    renderGenreChips(selectEl, host) {');
const end=source.indexOf('\n    async deleteUser(',start);
assert.ok(start>=0&&end>start);
function harness(){
  const listeners=[];
  const host={dataset:{},children:[],replaceChildren(...children){this.children=children;},addEventListener(name,callback){listeners.push({name,callback});}};
  const document={createElement(tag){return {tagName:tag,dataset:{},attributes:{},classList:{toggle(name,value){this.last=[name,value];}},setAttribute(name,value){this.attributes[name]=value;}};}};
  const render=vm.runInNewContext('({'+source.slice(start,end)+'}).renderGenreChips',{document,Event});
  const select={options:[{value:'action',textContent:'Action',selected:true},{value:'"/><script>bad</script>',textContent:'<img src=x onerror=bad()>',selected:false}],classList:{add(){}},events:[],dispatchEvent(event){this.events.push(event);}};
  return {render,select,host,listeners};
}
test('genre chips render without undefined escaping helpers and preserve literal text/values',()=>{
  const {render,select,host}=harness();render(select,host);
  assert.equal(host.children.length,2);
  assert.equal(host.children[0].type,'button');assert.equal(host.children[0].attributes['aria-pressed'],'true');
  assert.equal(host.children[1].dataset.value,select.options[1].value);
  assert.equal(host.children[1].textContent,select.options[1].textContent);
  assert.ok(!Object.hasOwn(host.children[1],'innerHTML'));
});
test('chip interaction updates the backing select once and maintains pressed state',()=>{
  const {render,select,host,listeners}=harness();render(select,host);render(select,host);
  assert.equal(listeners.length,1);assert.equal(listeners[0].name,'click');
  const chip=host.children[1];listeners[0].callback({target:{closest:()=>chip}});
  assert.equal(select.options[1].selected,true);assert.equal(chip.attributes['aria-pressed'],'true');
  assert.equal(select.events.length,1);assert.equal(select.events[0].type,'change');assert.equal(select.events[0].bubbles,true);
});
test('genre renderer accepts absent host or select while the page initializes',()=>{
  const {render,select,host}=harness();assert.doesNotThrow(()=>render(null,host));assert.doesNotThrow(()=>render(select,null));
});
