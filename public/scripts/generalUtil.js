function showToast(text) {
  let toastEl = document.getElementById("toast");
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.setAttribute("id", "toast");
    toastEl.setAttribute("class", "snackbar");
  }
  document.getElementsByTagName('main')[0].appendChild(toastEl);
  toastEl.innerText = text;
  toastEl.classList.add("snackbar-show");

  // After 3 seconds, remove the show class from DIV
  setTimeout(function(){ toastEl.classList.remove("snackbar-show"); }, 2900);
}

function pickTextColorBasedOnBgColor(bgColor, darkColor, lightColor) {
  let r = 0;
  let g = 0;
  let b = 0;
  if (bgColor.substring(0,3) === "rgb") {
    let rgb = bgColor.split( ',' ) ;
    r = parseInt( rgb[0].substring(4) ) ; // skip rgb(
    g = parseInt( rgb[1] ) ; // this is just g
    b = parseInt( rgb[2] ) ; // parseInt scraps trailing )
  } else {
    let hex = (bgColor.charAt(0) === '#') ? bgColor.substring(1, 7) : bgColor;
    r = parseInt(hex.substring(0, 2), 16); // hexToR
    g = parseInt(hex.substring(2, 4), 16); // hexToG
    b = parseInt(hex.substring(4, 6), 16); // hexToB
  }
  return (((r * 0.299) + (g * 0.587) + (b * 0.114)) > 160) ? darkColor : lightColor;
}

function removeSecondsFromDate(date) {
    if ( !date || date.length === 0) {
        return date;
    }
    return date.substring(0, date.length-8);
}