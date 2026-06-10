import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";

const DB_FILE = 'database.json';

function loadDB() {
    if (!fs.existsSync(DB_FILE)) return { users: [], locations: {} };
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

const server = new Server(
  {
    name: "workers-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_all_locations",
        description: "Get the realtime GPS locations of all registered workers, along with their names and Google Maps links.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "get_worker_location",
        description: "Get the realtime GPS location of a specific worker by name.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The name of the worker (can be partial)",
            },
          },
          required: ["name"],
        },
      }
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const db = loadDB();

  switch (request.params.name) {
    case "get_all_locations": {
      const locKeys = Object.keys(db.locations);
      if (locKeys.length === 0) {
        return { content: [{ type: "text", text: "Belum ada data lokasi pekerja." }] };
      }
      
      let result = "Daftar Lokasi Pekerja Terakhir:\n\n";
      locKeys.forEach(wa => {
          const loc = db.locations[wa];
          result += `- ${loc.name} (WA: ${wa})\n  Koordinat: ${loc.lat}, ${loc.lng}\n  Waktu: ${loc.timestamp}\n  Maps: https://maps.google.com/?q=${loc.lat},${loc.lng}\n\n`;
      });
      return { content: [{ type: "text", text: result }] };
    }

    case "get_worker_location": {
      const targetName = request.params.arguments.name.toLowerCase();
      const locKeys = Object.keys(db.locations);
      
      const foundWa = locKeys.find(wa => db.locations[wa].name.toLowerCase().includes(targetName));
      
      if (!foundWa) {
        return { content: [{ type: "text", text: `Pekerja dengan nama yang mengandung '${targetName}' tidak ditemukan atau belum mengirim lokasi.` }] };
      }
      
      const loc = db.locations[foundWa];
      const result = `Lokasi ${loc.name}:\nKoordinat: ${loc.lat}, ${loc.lng}\nWaktu: ${loc.timestamp}\nMaps: https://maps.google.com/?q=${loc.lat},${loc.lng}`;
      
      return { content: [{ type: "text", text: result }] };
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch(console.error);
