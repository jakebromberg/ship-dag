// Road-ahead interactions, run in the browser: draws each direct dependency as a curve
// from blocker to blocked ticket (the longest chain in the accent colour), redraws on
// resize, and on hover or keyboard focus dims everything outside the ticket's ancestors
// and descendants. Reads the edge list from #dag's data-edges attribute.
(()=>{const dag=document.getElementById('dag');if(!dag)return;
const E=JSON.parse(dag.dataset.edges),svg=dag.querySelector('svg'),N={};
dag.querySelectorAll('.node').forEach(n=>N[n.dataset.ref]=n);
const ns='http://www.w3.org/2000/svg';
function draw(){const b=dag.getBoundingClientRect();svg.setAttribute('width',dag.scrollWidth);svg.setAttribute('height',dag.scrollHeight);
 let h='<defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" style="fill:var(--muted);stroke:none"/></marker><marker id="ahc" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" style="fill:var(--accent);stroke:none"/></marker></defs>';
 for(const [a,c,crit] of E){const A=N[a],C=N[c];if(!A||!C)continue;const p=A.getBoundingClientRect(),q=C.getBoundingClientRect();
  const x1=p.left+p.width/2-b.left,y1=p.bottom-b.top,x2=q.left+q.width/2-b.left,y2=q.top-b.top-1,m=Math.max(18,(y2-y1)/2);
  h+=`<path data-a="${a}" data-b="${c}" class="${crit?'crit':''}" marker-end="url(#${crit?'ahc':'ah'})" d="M${x1},${y1} C${x1},${y1+m} ${x2},${y2-m} ${x2},${y2}"/>`}
 svg.innerHTML=h}
function focus(r){const n=N[r],keep=new Set([r,...(n.dataset.anc||'').split(' '),...(n.dataset.desc||'').split(' ')].filter(Boolean));
 dag.classList.add('focusing');for(const k in N)N[k].classList.toggle('dim',!keep.has(k));
 svg.querySelectorAll('path[data-a]').forEach(p=>p.classList.toggle('lit',keep.has(p.dataset.a)&&keep.has(p.dataset.b)))}
function clear(){dag.classList.remove('focusing');for(const k in N)N[k].classList.remove('dim')}
for(const k in N){const n=N[k];n.addEventListener('mouseenter',()=>focus(k));n.addEventListener('mouseleave',clear);n.addEventListener('focus',()=>focus(k));n.addEventListener('blur',clear)}
draw();addEventListener('resize',draw);if(window.ResizeObserver)new ResizeObserver(draw).observe(dag);if(document.fonts)document.fonts.ready.then(draw)})();
