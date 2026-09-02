const fs = require("fs");
const path = require("path");
const { chromium } = require("./dial9-viewer/ui/node_modules/playwright");

const outputDir = path.join(__dirname, "materiales", "imagenes");

const html = `<!doctype html>
<html>
  <head>
    <style>
      html, body { margin: 0; background: transparent; }
      .stage { display: inline-block; padding: 8px; }
      .card {
        display: inline-block;
        padding: 34px 42px;
        border-radius: 20px;
        background: #282c34;
      }
      pre {
        margin: 0;
        color: #abb2bf;
        font-family: "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        font-size: 30px;
        font-weight: 500;
        line-height: 1.52;
        tab-size: 4;
        white-space: pre;
      }
      .yellow { color: #e5c07b; }
      .purple { color: #c678dd; }
      .blue { color: #61afef; }
      .orange { color: #d19a66; }
      .green { color: #98c379; }
      .red { color: #e06c75; }
      .gray { color: #5c6370; font-style: italic; }
    </style>
  </head>
  <body>
    <div id="rust" class="stage">
      <div class="card"><pre><span class="yellow">#[dial9::main</span>(<span class="orange">config</span> = <span class="yellow">dial9::recorder_from_env</span>)]
<span class="purple">async fn</span> <span class="blue">main</span>() <span class="yellow">{</span>
    <span class="gray">// aplicación</span>
<span class="yellow">}</span></pre></div>
    </div>

    <div id="bash" class="stage">
      <div class="card"><pre><span class="red">DIAL9_ENABLED</span>=<span class="green">true</span> <span class="blue">cargo</span> <span class="green">run</span></pre></div>
    </div>
  </body>
</html>`;

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage({
    viewport: { width: 1800, height: 900 },
    deviceScaleFactor: 2,
  });

  await page.setContent(html);
  await page.locator("#rust").screenshot({
    path: path.join(outputDir, "config-rust.png"),
    omitBackground: true,
  });
  await page.locator("#bash").screenshot({
    path: path.join(outputDir, "config-bash.png"),
    omitBackground: true,
  });

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
