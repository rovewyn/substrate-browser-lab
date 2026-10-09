import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'substrate-external-client-check', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8931/mcp'));
await client.connect(transport);
try {
  const tools = await client.listTools();
  const result = await client.callTool({name:'browser_evaluate',arguments:{function:'() => ({url:location.href,token:window.lab?.token,counter:window.lab?.counter,timeOrigin:performance.timeOrigin,proof:window.frontProof})'}});
  if (result.isError) throw new Error(JSON.stringify(result));
  const report = {sdk:'@modelcontextprotocol/sdk@1.32.1',endpoint:'http://127.0.0.1:8931/mcp',session:transport.sessionId,
    toolCount:tools.tools.length,tools:tools.tools.map(t=>t.name),result};
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const target=path.join(root, 'outputs/substrate-browser-mcp-client.json');
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  // Close this connection without issuing browser_close on the shared context.
  await client.close();
}
