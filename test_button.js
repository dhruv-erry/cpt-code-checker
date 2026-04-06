const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://localhost:3000');
  
  await new Promise(r => setTimeout(r, 2000));
  
  const data = await page.evaluate(() => {
    const btn = document.querySelector('header.page-header button');
    if (!btn) return "BUTTON NOT FOUND in DOM";
    const header = document.querySelector('header.page-header');
    
    const rect = btn.getBoundingClientRect();
    const style = window.getComputedStyle(btn);
    const headerRect = header.getBoundingClientRect();
    
    return {
      text: btn.innerText,
      className: btn.className,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
      headerRect: { x: headerRect.x, y: headerRect.y, width: headerRect.width, right: headerRect.right },
      windowWidth: window.innerWidth,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      color: style.color,
      backgroundColor: style.backgroundColor,
    };
  });
  
  console.log("DESKTOP VIEW:", JSON.stringify(data, null, 2));

  // Switch to narrow viewport
  await page.setViewport({ width: 400, height: 800 });
  await new Promise(r => setTimeout(r, 1000));
  
  const mobileData = await page.evaluate(() => {
    const btn = document.querySelector('header.page-header button');
    if (!btn) return "BUTTON NOT FOUND in DOM";
    const header = document.querySelector('header.page-header');
    
    const rect = btn.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    
    return {
      rect: { x: rect.x, width: rect.width, right: rect.right },
      headerRect: { width: headerRect.width, right: headerRect.right },
      windowWidth: window.innerWidth,
    };
  });
  
  console.log("MOBILE VIEW:", JSON.stringify(mobileData, null, 2));

  await browser.close();
})();
