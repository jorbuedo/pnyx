/**
 * `@pnyx/mcp-server` — the wallet's MCP tool surface.
 *
 * The read surface is the dApp connector's, exposed to an agent instead of a page: those tools forward
 * to a method `@pnyx/dapp-connector` already implements and already gates. Beside them sit the tools
 * the app answers itself — its transaction cache, and the builders that fill the hole CIP-30 leaves by
 * never building anything. Transport lives elsewhere; this package takes a JSON-RPC frame and returns
 * one.
 *
 * @module
 */

export {
  type ConnectorToolBinding,
  findTool,
  isConnectorTool,
  type LocalToolBinding,
  localArgs,
  TOOLS,
  type ToolBinding,
  toolDescriptors,
} from './catalogue.js'
export {
  createMcpServer,
  type LocalToolOutcome,
  type LocalToolRunner,
  type McpCaller,
  type McpServer,
  type McpServerConfig,
  type ServerInfo,
} from './protocol.js'
export {findResource, RESOURCES, type ResourceDoc, resourceDescriptors} from './resources.js'
export {
  JsonRpcErrorCode,
  type JsonRpcRequest,
  type JsonRpcResponse,
  PREFERRED_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ToolDescriptor,
  type ToolResult,
} from './types.js'
