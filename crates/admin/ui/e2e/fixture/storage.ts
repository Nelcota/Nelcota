import { requiredValue } from "../../src/lib/contracts/required-value.js";
import type { FixtureEndpoint } from "./types.js";
export const storageEndpoints: readonly FixtureEndpoint[] = [
  {
    matches: ({ path }) => path === "/storage",
    respond: ({ data: { bucket } }) => {
      return {
        status: 200,
        json: {
          enabled: true,
          backend: "disk",
          max_file_size: 52428800,
          max_total_size: null,
          public_url: null,
          buckets: [bucket],
        },
      };
    },
  },
  {
    matches: ({ path }) => path === "/storage/buckets/documents",
    respond: ({ data: { bucket } }) => {
      return { status: 200, json: bucket };
    },
  },
  {
    matches: ({ path, method }) => path === "/storage/buckets/documents/access" && method === "GET",
    respond: () => {
      return {
        status: 200,
        json: {
          bucket: "documents",
          public: false,
          policies: [
            {
              name: "documents_own_folder",
              command: "ALL",
              roles: ["authenticated"],
              using:
                "((bucket_id = 'documents'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text))",
              check:
                "((bucket_id = 'documents'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text))",
              all_buckets: false,
            },
          ],
        },
      };
    },
  },
  {
    matches: ({ path, method }) => path === "/storage/buckets/documents/file" && method === "GET",
    respond: ({ url }) => {
      const name = url.searchParams.get("name");
      if (name?.endsWith(".png") === true)
        return {
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
          ),
        };
      if (name?.endsWith(".pdf") === true)
        return {
          contentType: "application/pdf",
          body: "%PDF-1.4\n1 0 obj<</Type /Catalog>>endobj\n%%EOF",
        };
      return {
        contentType: "text/plain",
        body: "Arquivo de exemplo\nPrévia em texto com acentos.",
      };
    },
  },
  {
    matches: ({ path }) => path.endsWith("/objects"),
    respond: ({ prefix, data: { stamp, rows } }) => {
      return {
        status: 200,
        json: {
          folders: prefix !== "" ? [] : ["reports"],
          objects: ["readme.txt", "screenshot.png", "report.pdf"].map((name, i) => ({
            id: requiredValue(rows[i], "fixture row").id,
            name,
            size: 32768 * (i + 1),
            mime_type: ["text/plain", "image/png", "application/pdf"][i],
            owner: null,
            updated_at: stamp,
          })),
          has_next: false,
        },
      };
    },
  },
];
