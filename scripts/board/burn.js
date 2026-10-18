// Burn-up keyboard support, run in the browser. The chart's steps are a roving tab stop: one step is in the tab
// order, and Left, Right, Home and End move focus (and with it the tooltip, which CSS shows on focus) between them.
(()=>{document.querySelectorAll('.burn .plot').forEach(plot=>{const pts=[...plot.querySelectorAll('.pt')];
plot.addEventListener('keydown',e=>{const i=pts.indexOf(document.activeElement);if(i<0)return;
 const j={ArrowLeft:i-1,ArrowRight:i+1,Home:0,End:pts.length-1}[e.key];if(j===undefined||j<0||j>=pts.length)return;
 e.preventDefault();pts[i].tabIndex=-1;pts[j].tabIndex=0;pts[j].focus()})})})();
