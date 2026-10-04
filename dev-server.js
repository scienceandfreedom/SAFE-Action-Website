// Simple dev server with Vercel-style rewrites
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const ROOT = __dirname;

const MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
    '.webp': 'image/webp', '.webmanifest': 'application/manifest+json',
};

// Rewrites matching vercel.json
const REWRITES = [
    { pattern: /^\/candidates\/([^/]+)$/, dest: (m) => `/candidate.html?slug=${m[1]}` },
    { pattern: /^\/record\/([^/]+)$/, dest: () => '/record.html' },
    { pattern: /^\/admin$/, dest: () => '/admin.html' },
    { pattern: /^\/feed$/, dest: () => '/feed.html' },
    { pattern: /^\/(a[klrz]|c[aot]|d[ce]|fl|ga|hi|i[adln]|k[sy]|la|m[adeinost]|n[cdehjmvy]|o[hkr]|pa|ri|s[cd]|t[nx]|ut|v[at]|w[aivy])$/i, dest: () => '/state.html' },
];

http.createServer((req, res) => {
    let url = req.url.split('?')[0];
    let query = req.url.includes('?') ? req.url.split('?')[1] : '';

    // Check rewrites
    for (const rule of REWRITES) {
        const match = url.match(rule.pattern);
        if (match) {
            const dest = rule.dest(match);
            const [destPath, destQuery] = dest.split('?');
            url = destPath;
            query = destQuery ? (query ? destQuery + '&' + query : destQuery) : query;
            // Inject query params as a script tag for client-side access
            break;
        }
    }

    // Clean URLs: /about -> /about.html
    let filePath = path.join(ROOT, url === '/' ? 'index.html' : url);

    // If no extension and file doesn't exist, try .html
    if (!path.extname(filePath) && !fs.existsSync(filePath)) {
        filePath += '.html';
    }

    // Serve file
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<h1>404 Not Found</h1>');
            return;
        }

        const ext = path.extname(filePath);
        const mime = MIME[ext] || 'application/octet-stream';

        // For HTML files with query params from rewrites, inject them
        if (ext === '.html' && query) {
            let html = data.toString();
            // Inject query params so client JS can read them
            const inject = `<script>
                // Injected by dev-server for rewrite support
                (function() {
                    var params = new URLSearchParams('${query}');
                    var original = URLSearchParams.prototype;
                    var _get = original.get;
                    var fakeParams = params;
                    if (!window.location.search) {
                        var origSearch = Object.getOwnPropertyDescriptor(URL.prototype, 'search') ||
                                         Object.getOwnPropertyDescriptor(Location.prototype, 'search');
                        // Patch URLSearchParams constructor when called with window.location.search
                        var OrigURLSearchParams = window.URLSearchParams;
                        window.URLSearchParams = function(init) {
                            if (init === '' || init === undefined || init === window.location.search) {
                                return new OrigURLSearchParams('${query}');
                            }
                            return new OrigURLSearchParams(init);
                        };
                        window.URLSearchParams.prototype = OrigURLSearchParams.prototype;
                    }
                })();
            </script>`;
            html = html.replace('<head>', '<head>' + inject);
            res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
            res.end(html);
            return;
        }

        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
        res.end(data);
    });
}).listen(PORT, () => {
    console.log(`Dev server running at http://localhost:${PORT}`);
});
