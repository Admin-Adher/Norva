export default async function* reporter(events){
 let last;
 for await(const e of events){
  if(e.type==='test:fail')yield 'FAIL '+e.data.name+': '+String(e.data.details?.error?.message??'').slice(0,180)+'\n';
  if(e.type==='test:summary')last={summary:e.data.counts,success:e.data.success};
 }
 if(last)yield JSON.stringify(last)+'\n';
}
