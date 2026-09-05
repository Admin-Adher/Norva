'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),acorn=require('acorn'),parse5=require('parse5');
const root=path.resolve(__dirname,'../..'),apply=process.argv.includes('--apply');
const registryPath=path.join(root,process.argv.find(a=>a.startsWith('--catalog='))?.slice(10)||'i18n/web.json');const registry=fs.existsSync(registryPath)?JSON.parse(fs.readFileSync(registryPath)):{};
const seen=new Map(Object.entries(registry).map(([k,e])=>[e.source,k]));const files=[];const errors=[];
const normalize=s=>s.replace(/\s+/g,' ').trim();
const reviewedUi=require('../../i18n/reviewed-ui-literals.json');
const codeValues=new Set(require('../../i18n/code-values.json'));
const readable=s=>!codeValues.has(s.trim())&&/\p{L}{2}/u.test(s.replace(/ZXQI18N\d+ZXQ/g,''))&&!/^(?:https?:|\/|#[\w-]+$)/.test(s.trim())&&!/^(?:Norva(?: TV| Hub| Cloud)?|Google|Chromecast|Wi-Fi|SSO|M3U8?|Xtream|IPTV|HTTP|HTTPS|OK|SDH|HDR|HD|UHD|4K|MB|GB|Mbps)$/i.test(s.trim());
function register(text,file){text=normalize(text);if(!seen.has(text)){const key='ui_web_'+crypto.createHash('sha256').update(text).digest('hex').slice(0,12);seen.set(text,key);registry[key]={source:text,refs:[]};}const key=seen.get(text);if(!registry[key].refs.includes(file))registry[key].refs.push(file);return key;}
const quote=s=>JSON.stringify(s);
const attr=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll("'",'&#39;');
function editsApply(source,edits){edits.sort((a,b)=>b.start-a.start||b.end-a.end);let last=source.length+1;for(const e of edits){if(e.end>last)throw Error('Overlapping UI migration edits');source=source.slice(0,e.start)+e.text+source.slice(e.end);last=e.start;}return source;}
function markup(source,file,expressions=[]){const doc=(/^\s*(?:<!doctype|<html)/i.test(source)?parse5.parse:parse5.parseFragment)(source,{sourceCodeLocationInfo:true});const edits=[],insertions=new Map();
 function parameters(text){const values={};text=text.replace(/ZXQI18N(\d+)ZXQ/g,(_,n)=>{values['p'+n]=expressions[Number(n)];return '{{p'+n+'}}';});return {text,values};}
 function argsAttribute(name,values){if(!Object.keys(values).length)return '';const code=Object.entries(values).map(([k,v])=>quote(k)+':('+unwrap(v)+')').join(',');return ` ${name}="ZXQGENERATEDSTART${Buffer.from('(globalThis.NorvaI18n?.args({'+code+'}) || '+quote('{}')+')').toString('base64')}ZXQGENERATEDEND"`;}
 function annotate(node,name,text){const p=parameters(normalize(text));const key=register(p.text,file);let addition=` ${name}="${key}"`+argsAttribute(name+'-args',p.values);const loc=node.sourceCodeLocation?.startTag;if(!loc)return false;const offset=loc.endOffset-(source[loc.endOffset-2]==='/'?2:1);insertions.set(offset,(insertions.get(offset)||'')+addition);return true;}
 function visit(node,skip=false){const attrs=Object.fromEntries((node.attrs||[]).map(a=>[a.name,a.value]));skip||=['script','style','code','pre'].includes(node.tagName)||attrs.translate==='no'||attrs['data-i18n-ignore']!==undefined;if(skip)return;
 for(const name of ['title','placeholder','aria-label','alt'])if(attrs[name]&&!attrs['data-i18n-'+name]&&readable(attrs[name]))annotate(node,'data-i18n-'+name,attrs[name]);
 if(node.nodeName==='#text'&&readable(node.value)) {const parent=node.parentNode,pa=Object.fromEntries((parent?.attrs||[]).map(a=>[a.name,a.value]));if(!pa['data-i18n']){const location=node.sourceCodeLocation;if(location){const leaf=(parent.childNodes||[]).every(n=>n.nodeName==='#text');if(!(leaf&&annotate(parent,'data-i18n',node.value))){const p=parameters(normalize(node.value)),key=register(p.text,file);const tag=parent.namespaceURI==='http://www.w3.org/2000/svg'?'tspan':'norva-i18n';const raw=source.slice(location.startOffset,location.endOffset);edits.push({start:location.startOffset,end:location.endOffset,text:`<${tag} data-i18n="${key}"${argsAttribute('data-i18n-args',p.values)}>${raw}</${tag}>`});}}}}
 for(const child of node.childNodes||[])visit(child,skip);if(node.content)visit(node.content,skip);
 }visit(doc);for(const[start,text]of insertions)edits.push({start,end:start,text});return editsApply(source,edits);}
function unwrap(source){try{const e=acorn.parseExpressionAt(source,0,{ecmaVersion:'latest'});const name=e.callee?.property?.name||e.callee?.name;if(e.type==='CallExpression'&&['escapeHtml','escapeAttribute','escapeText','_escapeHtml'].includes(name)&&e.arguments.length===1)return source.slice(e.arguments[0].start,e.arguments[0].end);}catch{}return source;}
function isUi(node,parent,ancestors=[],source="",file=""){if(!parent)return false;
 const rawText=node.type==='Literal'?node.value:node.quasis?.map(q=>q.value.cooked||'').join(' ');
 if(typeof rawText==='string' && /^(?:disabled|selected|checked)\s|\b(?:class|aria-disabled|style|title)=["']/.test(rawText))return false;
 const boundary=ancestors.findLastIndex(n=>['FunctionExpression','ArrowFunctionExpression','FunctionDeclaration'].includes(n.type));
 if(ancestors.slice(boundary+1).some(n=>['CallExpression','NewExpression'].includes(n.type)&&['DateTimeFormat','NumberFormat','RelativeTimeFormat','Date','getElementById','querySelector','querySelectorAll','closest','matches','getAttribute','removeAttribute','toLocaleString','toLocaleDateString','toLocaleTimeString','fetch','includes','startsWith','endsWith','handlePlaybackError'].includes(n.callee.property?.name||n.callee.name)))return false;
 const scope=ancestors.findLast(n=>n.type==='MethodDefinition'||n.type==='FunctionDeclaration');
 const scopeName=scope?.key?.name||scope?.id?.name||'';
 if(node.type==='Literal' && reviewedUi.some(r=>r.file===file && (r.scope||'')===scopeName && r.source===node.value) && !(parent.type==='Property'&&parent.key===node) && !(parent.type==='BinaryExpression'&&['===','!==','==','!='].includes(parent.operator)))return true;
 const displayScope=/formatStatus|reportingReason|formatCurrencyBalances|referencePayoutThreshold|formatDateTime|formatMinor|getMovieOverview|getSeriesOverview|openPayoutDialog|_episodeListInnerHtml|_partnersKycCertificationRequirementRows|_clientPriority|_clientBilling|_loadTicketContext|_renderBillingPanel|_partnersLoadView|_partnersLoadFinanceView|_partnersRetryModule|_partnersCapabilityCards|cashKycProgressModel|membershipProgramFacts|showTvRelay|initTranscodeWizard|steps|membershipSteps|getFriendlyPlaybackError|getSeriesInfoError|presentLifecycleImportHelp|sourceFormatSwitcher|sourceInputFeedback|showAddModal|showEditModal|getSourceForm|catalogErrorDetails|catalogMilestones|populateSignInMethods|setupSteps|hero|accountSection|trial|Trial|Markup|buildCard|buildChannelItemHtml|buildSearchResultHtml|render|Label|Title|Message|Caption|Copy|Subtitle|Tooltip|Hint|Headline|Badge|relativeTime|FormatMinor|Precision|_aiFailureShort|_aiEtaText|planName|Summary|LocationStatus|_runPartnersAdminAction|setupContextGuide|bindSetupConnectionForm/.test(scopeName);
 const text=node.type==='Literal'?node.value:node.quasis?.map(q=>q.value.cooked||'').join(' ');
 const natural=typeof text==='string'&&(/[\p{L}]{2}\s+[\p{L}]{2}/u.test(text)||/^[A-ZÀ-Ž][a-zÀ-ž]/.test(text));
 const displayVariable=ancestors.findLast(a=>a.type==='VariableDeclarator')?.id?.name||'';
 if(natural && /Label|Title|Copy|Message|Caption|Hint|Headline|Options$|^guidance$/.test(displayVariable) && ((parent.type==='Property' && parent.value===node)||(parent.type==='ArrayExpression'&&parent.elements.indexOf(node)>0)))return true;
 if(natural && ['ConditionalExpression','LogicalExpression'].includes(parent.type) && parent.test!==node && /Label|Title|Copy|Message|Caption|Hint|Headline|labelText|detailText/.test(displayVariable))return true;
 if(natural && ['AUDIENCES','NOTIFICATION_EVENTS'].includes(scopeName) && parent.type==='ArrayExpression' && parent.elements.indexOf(node)>0)return true;
 if(natural && scopeName==='behavioralStepCopyValidation' && (parent.type==='ReturnStatement' || (parent.type==='ArrayExpression' && parent.elements.indexOf(node)===2) || (parent.type==='CallExpression' && parent.callee.name==='add' && parent.arguments.indexOf(node)===2)))return true;
 if(natural && parent.type==='ArrayExpression' && parent.elements.indexOf(node)===0 && displayVariable==='labels')return true;
 if(natural && parent.type==='Property' && parent.value===node && /Label|Title|Copy|Message|Caption|Hint|Headline|Badge|Summary/.test(scopeName))return true;
 if(parent.type==='ReturnStatement'&&(displayScope||ancestors.some(a=>a.type==='VariableDeclarator'&&a.id?.name==='formatStatus')))return true;
 const inConditionTest=ancestors.some(a=>a.type==='ConditionalExpression'&&a.test.start<=node.start&&a.test.end>=node.end);
 if(!inConditionTest){
   const assignment=ancestors.findLast(a=>a.type==='AssignmentExpression');
   if(assignment&&['textContent','innerText','placeholder','title','ariaLabel'].includes(assignment.left.property?.name)&&assignment.right.start<=node.start)return true;
   if(ancestors.some(a=>a.type==='Property'&&(a.key?.name||a.key?.value)==='labels')&&parent.type==='Property'&&parent.value===node)return true;
   if(scopeName==='providerAccessNoticeCopy'&&parent.type==='ArrayExpression')return true;
   if(ancestors.some(a=>a.type==='VariableDeclarator'&&a.id?.name==='NORVA_DEVICE_APPS')&&parent.type==='Property'&&parent.key.name==='name')return true;
   const displayCall=ancestors.findLast(a=>a.type==='CallExpression'&&['confirm','showToast','toast','announce','setAttribute'].includes(a.callee.property?.name||a.callee.name));
   if(displayCall&&natural){const name=displayCall.callee.property?.name||displayCall.callee.name;const index=displayCall.arguments.findIndex(a=>a.start<=node.start&&a.end>=node.end);
     if(name==='confirm'&&index<2)return true;
     if(['showToast','toast','announce'].includes(name)&&index===0)return true;
     if(name==='setAttribute'&&index===1&&['title','aria-label','placeholder','alt'].includes(displayCall.arguments[0]?.value))return true;
   }
 }

 if(!inConditionTest && natural){
   const assignment=ancestors.findLast(a=>a.type==='AssignmentExpression');
   if(assignment && assignment.right.start<=node.start && /^(?:title|label|hint|message|caption|subtitle|copy|detail|text|summary|statusText|buttonText|actionLabel)$/.test(assignment.left.name||''))return true;
   const uiCall=ancestors.findLast(a=>a.type==='CallExpression'&&['el','setProfileStatus','setSheetStatus','setStatus','setMessage','setActionStatus','setFieldError','row'].includes(a.callee.property?.name||a.callee.name));
   if(uiCall){const name=uiCall.callee.property?.name||uiCall.callee.name;const index=uiCall.arguments.findIndex(a=>a.start<=node.start&&a.end>=node.end);if((name==='el'&&index===2)||(name==='setProfileStatus'&&index===1)||(['setSheetStatus','setStatus','setMessage','setActionStatus'].includes(name)&&index<=1&&index>=0&&!/^[a-z][a-z0-9_-]*$/.test(text))||(name==='setFieldError'&&index===1)||(name==='row'&&index>0))return true;}
   if(displayScope && parent.type==='CallExpression'&&['escapeHtml','escapeText','esc','_escapeHtml'].includes(parent.callee.property?.name||parent.callee.name))return true;
 }
 if(natural && !/^[a-z][a-z0-9_-]*$/.test(text) && displayScope && parent.type==='Property' && parent.value===node && !/^(?:id|key|code|type|name|status|event|reason|action|route|endpoint|className|style)$/.test(parent.key.name||parent.key.value||''))return true;
 if(natural && parent.type==='NewExpression' && parent.callee.name==='Error' && /^Le |^La |^Les |^Utilisez |^Choisissez |^Ajoutez |^Saisissez /.test(text) && /^_wireBehavioral|^_wireNotification|^_loadWebPrices/.test(scopeName))return true;
 if(natural && parent.type==='AssignmentPattern' && parent.right===node && /title|label|message|text|copy/i.test(parent.left.name||''))return true;
 if(natural && parent.type==='Property' && parent.value===node && parent.key.name!=='errorMessage' && /Label$|Title$|Message$|Text$/.test(parent.key.name||parent.key.value||''))return true;
 if(natural && parent.type==='ArrayExpression' && parent.elements.indexOf(node)>0 && ['getProviderAccessTermsFields','catalogMilestones'].includes(scopeName))return true;
 if(natural && file.endsWith('MkvStrategyLabPage.js') && parent.type==='Property' && parent.value===node && ['video','audio','gop','validator','subtitles','short'].includes(parent.key.name||parent.key.value))return true;
 const containingTemplate=ancestors.findLast(a=>a.type==='TemplateLiteral');
 if(natural&&containingTemplate&&['ConditionalExpression','LogicalExpression','BinaryExpression','CallExpression'].includes(parent.type)) {
   const expr=containingTemplate.expressions.find(e=>e.start<=node.start&&e.end>=node.end);
   if(expr){const index=containingTemplate.expressions.indexOf(expr),prefix=containingTemplate.quasis[index].value.cooked||'';
     if(prefix.includes('>')&&prefix.lastIndexOf('>')>prefix.lastIndexOf('<')&&!codeValues.has(text))return true;}
 }
 const owningVariable=ancestors.findLast(a=>a.type==='VariableDeclarator');
 if(natural&&['ConditionalExpression','LogicalExpression','BinaryExpression'].includes(parent.type)&&/^(?:title|label|hint|message|caption|subtitle|copy|detail|text|statusText|emptyText|buttonText|statusLabel|emptyLabel|buttonLabel)$/i.test(owningVariable?.id?.name||''))return true;
 if(parent.type==='VariableDeclarator'&&/title|label|hint|message|caption|subtitle|copy/i.test(parent.id?.name||'')&&natural)return true;
 if(['ConditionalExpression','LogicalExpression'].includes(parent.type)&&parent.test!==node&&displayScope&&natural){
   const container=ancestors.findLast(n=>n.type==='TemplateLiteral');
   const variable=ancestors.findLast(n=>n.type==='VariableDeclarator');
   if(/class|style|selector|endpoint|query|url/i.test(variable?.id?.name||''))return false;
   if(container){const expr=container.expressions.find(e=>e.start<=node.start&&e.end>=node.end);if(expr){const index=container.expressions.indexOf(expr),prefix=container.quasis[index].value.cooked||'';if(prefix.lastIndexOf('<')>prefix.lastIndexOf('>')&&!/(?:aria-label|title|placeholder|alt)=["'][^"']*$/.test(prefix))return false;}}
   return true;
 }
 if(parent.type==='AssignmentExpression'&&parent.right===node)return ['textContent','innerText','placeholder','title','ariaLabel'].includes(parent.left.property?.name);
 if(parent.type==='Property'&&parent.value===node&&ancestors.some(a=>a.type==='VariableDeclarator'&&a.id?.name==='T')&&['accept','refuse','more','aria'].includes(parent.key.name))return true;
 if(parent.type==='Property'&&parent.value===node)return ['label','message','hint','placeholder','description','title','detail','actionLabel','buttonLabel','ctaLabel','shortLabel','sub','note','tooltip','explanation','emptyText','loadingText','confirmText','cancelText','text','copy','caption','subtitle','body','help','cta','kicker','ariaLabel','confirmLabel','cancelLabel','allText','searchPlaceholder','emptyLabel'].includes(parent.key.name||parent.key.value);
 if(parent.type==='CallExpression'){const name=parent.callee.property?.name||parent.callee.name;const i=parent.arguments.indexOf(node);if(['prompt','_prompt','_partnersPrompt','_partnersPromptJson','_confirm','_toast','header','_setCrumb','unavailable','getTrackLabel'].includes(name))return i===0;
 if(natural&&['setTvLaunchPhase','setSheetStatus','failStep','openProviderAccessModal','setBusy','updateTranscodeStatus','card','item','sysCard','setStatus','setMessage','setCampaignMessage','kv','statusCard','statusBox','ctaBtn','demarche','doneBtn','dlCard','withCount','_partnersEnsureAal2','_setFicheChip','row','chip','metric','stat','fact','bar','statusPill','pill','svc','gauge','exceptionCard','group','setFieldError','showSummaryError','applyFacetOptions','liveRegion','setActionStatus','runPartnerAction','statusLabel','runKycRightsAction','openCashStatusDialog','runAction','withPlan'].includes(name))return true;
 if(name==='_partnersOpsUnavailable')return i===1;
 if(name==='setAttribute')return i===1&&['title','aria-label','placeholder','alt'].includes(parent.arguments[0]?.value);return i===0&&['alert','confirm','showToast','toast','showError','createTextNode','setCustomValidity','announce','announceStatus'].includes(name);}return false;}
function javascript(source,file){let tree;try{tree=acorn.parse(source,{ecmaVersion:'latest',sourceType:'module'});}catch(e){errors.push({file,message:e.message});return source;}const edits=[];
 function visit(node,parent,ancestors=[]){if(!node||typeof node!=='object')return;
 if(node.type==='CallExpression'&&node.callee?.object?.property?.name==='NorvaI18n'){
  if(node.callee.property?.name==='t'){for(const p of node.arguments[1]?.properties||[])if(/^p\d+$/.test(p.key?.name||p.key?.value||''))visit(p.value,p,[...ancestors,node,p]);}
  else if(node.callee.property?.name==='args')for(const arg of node.arguments)visit(arg,node,[...ancestors,node]);
  return;
 }
 if(['ConditionalExpression','LogicalExpression'].includes(node.type)&&source.slice(node.start,Math.min(node.start+50,node.end)).includes('NorvaI18n')){visit(node.type==='LogicalExpression'?node.left:node.consequent,node,[...ancestors,node]);return;}
 let changed=false;
 if(node.type==='TemplateLiteral'){const expressions=node.expressions.map(e=>source.slice(e.start,e.end));const plain=node.quasis.map((q,i)=>(q.value.cooked??q.value.raw)+(i<expressions.length?'ZXQI18N'+i+'ZXQ':'')).join('');if(/<[a-z][\s\S]*>/i.test(plain)&&!plain.includes('data-i18n-args="ZXQGENERATED')){let next=markup(plain,file,expressions);if(next!==plain){next=next.replaceAll('\\','\\\\').replaceAll('`','\\`').replaceAll('${','\\${').replace(/ZXQI18N(\d+)ZXQ/g,(_,n)=>'${'+expressions[Number(n)]+'}').replace(/ZXQGENERATEDSTART([\s\S]*?)ZXQGENERATEDEND/g,(_,expr)=>'${'+Buffer.from(expr,'base64').toString('utf8')+'}');edits.push({start:node.start,end:node.end,text:'`'+next+'`'});changed=true;}}
 else if(isUi(node,parent,ancestors,source,file)&&readable(plain)){const text=plain.replace(/ZXQI18N(\d+)ZXQ/g,(_,n)=>'{{p'+n+'}}');const key=register(text,file);const args=expressions.map((e,i)=>'p'+i+':('+e+')').join(',');edits.push({start:node.start,end:node.end,text:`(globalThis.NorvaI18n ? globalThis.NorvaI18n.t(${quote(key)}, {${args}}) : ${source.slice(node.start,node.end)})`});changed=true;}}
 if(node.type==='Literal'&&typeof node.value==='string'){if(/<[a-z][\s\S]*>/i.test(node.value)){const next=markup(node.value,file);if(next!==node.value){edits.push({start:node.start,end:node.end,text:quote(next)});changed=true;}}else if(isUi(node,parent,ancestors,source,file)&&readable(node.value)){const key=register(node.value,file);edits.push({start:node.start,end:node.end,text:`(globalThis.NorvaI18n?.t(${quote(key)}) ?? ${source.slice(node.start,node.end)})`});changed=true;}}
 if(changed)return;for(const[key,child]of Object.entries(node)){if(['start','end','loc'].includes(key))continue;if(Array.isArray(child))child.forEach(n=>visit(n,node,[...ancestors,node]));else if(child&&typeof child==='object')visit(child,node,[...ancestors,node]);}
 }visit(tree);return editsApply(source,edits);}
function walk(dir){return fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):[dir+'/'+e.name]);}
for(const file of walk('public/js').filter(f=>f.endsWith('.js')&&!f.includes('/vendor/')&&!['public/js/i18n.js'].includes(f))){const original=fs.readFileSync(path.join(root,file),'utf8');const next=javascript(original,file);if(next!==original){files.push(file);if(apply)fs.writeFileSync(path.join(root,file),next);}}
for(const name of fs.readdirSync(path.join(root,'public')).filter(f=>f.endsWith('.html')&&f!=='probe.html')){const file='public/'+name;const original=fs.readFileSync(path.join(root,file),'utf8');let next=markup(original,file);next=next.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g,(all,open,code,close)=>!code.trim()||/type=["'](?:application\/|importmap)/.test(open)?all:open+javascript(code,file)+close);if(!next.includes('/js/i18n.js'))next=next.replace(/<meta charset="UTF-8"\s*\/?\s*>/i,m=>m+'\n    <script src="/js/i18n.js?v=pending"></script>');if(!next.includes('/css/i18n.css'))next=next.replace('</head>','    <link rel="stylesheet" href="/css/i18n.css?v=pending">\n</head>');if(next!==original){files.push(file);if(apply)fs.writeFileSync(path.join(root,file),next);}}
if(!process.argv.includes('--no-catalog'))fs.writeFileSync(registryPath,JSON.stringify(registry,null,2)+'\n');fs.writeFileSync(path.join(root,'output/i18n/web-migration.json'),JSON.stringify({apply,files,errors,messages:Object.keys(registry).length},null,2));console.log({apply,files:files.length,errors,messages:Object.keys(registry).length});if(errors.length)process.exitCode=1;
