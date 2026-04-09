import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function normalizeCommerceApiBaseUrlEnv() {
  if (process.env.GODADDY_API_BASE_URL) return;

  const hostOnly = process.env.VITE_GODADDY_API_HOST;
  if (!hostOnly) return;

  const normalizedHost = hostOnly.replace(/^https?:\/\//, "").trim();
  if (!normalizedHost) return;

  process.env.GODADDY_API_BASE_URL = `https://${normalizedHost}`;
}

export const viteServerBefore = (server, viteServer) => {
  console.log("VITEJS SERVER");
  normalizeCommerceApiBaseUrlEnv();
  server.use(express.json());
  server.use(express.urlencoded({ extended: true }));
};

export const viteServerAfter = (server, viteServer) => {
  const errorHandler = (err, req, res, next) => {
    if (err instanceof Error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    } else {
      next(err);
    }
  };
  server.use(errorHandler);
};

// ServerHook
export const serverBefore = (server) => {
  normalizeCommerceApiBaseUrlEnv();

  const shutdown = async (signal) => {
    console.log(`Got ${signal}, shutting down gracefully...`);

    try {
      // Opaque path prevents vite-plugin-api-routes from resolving at build time.
      // At runtime, the try/catch handles the missing module gracefully.
      const dbClient = "./db/client" + ".js";
      const { closeConnection } = await import(dbClient);
      await closeConnection();
      console.log("Database connections closed");
    } catch (error) {
      // Database skill not installed or module failed to load
      if (error.code !== 'ERR_MODULE_NOT_FOUND') {
        console.error("Error during database shutdown:", error.message);
      }
    }

    process.exit(0);
  };

  ["SIGTERM", "SIGINT"].forEach((signal) => {
    process.once(signal, shutdown);
  });

  server.use(express.json());
  server.use(express.urlencoded({ extended: true }));

  server.use(express.static(join(__dirname, "client"), {
    setHeaders(res, filePath) {
      // Vite content-hashes everything in assets/ — safe to cache long-term.
      // Everything else (index.html, analytics.js, etc.) must revalidate.
      res.set("Cache-Control", filePath.includes("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache");
    }
  }));

  // No-cache for dynamic responses (API routes, SPA fallback, etc.).
  // express.static already sent the response for static files above.
  server.use((req, res, next) => {
    res.set("Cache-Control", "no-cache");
    next();
  });
};

export const serverAfter = (server) => {
  // Add SPA fallback for client-side routing
  // This middleware serves index.html for any GET request that doesn't match
  // an API endpoint or static file, enabling React Router to handle the route
  server.use((req, res, next) => {
    // Only handle GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Skip if this is an API request
    if (req.path.startsWith('/api')) {
      return next();
    }

    // Skip if this is a static asset request (has file extension)
    if (extname(req.path)) {
      return next();
    }

    // For all other GET requests, serve index.html to support client-side routing
    res.sendFile(join(__dirname, 'client', 'index.html'));
  });

  const errorHandler = (err, req, res, next) => {
    if (err instanceof Error) {
      res.status(500).json({ error: err.message });
    } else {
      next(err);
    }
  };
  server.use(errorHandler);
};
