// Board reload, run in the browser. Reloads the page once it is visible and has been open for the period its script
// tag names (data-period, in seconds). It measures the time since load on every check instead of trusting one timer,
// because a browser can leave a background tab's timer unfired (throttled, frozen or suspended) and does not schedule
// a meta refresh again for a page restored from the back-forward cache. A hidden page never reloads; a return to the
// tab (visibilitychange, focus, pageshow) runs the check at once, so the page is current as soon as it is seen.
(()=>{const tag=document.currentScript,ms=1000*Number(tag&&tag.dataset.period),loaded=Date.now();if(!(ms>0))return;
const check=()=>{if(!document.hidden&&Date.now()-loaded>=ms)location.reload()};
setInterval(check,15000);document.addEventListener('visibilitychange',check);
window.addEventListener('focus',check);window.addEventListener('pageshow',check)})();
