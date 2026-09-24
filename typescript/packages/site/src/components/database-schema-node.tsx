import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { memo, type ReactNode } from "react";

export interface SchemaColumn {
  name: string;
  nullable: boolean;
  primaryKey: boolean;
  type: string;
}

export interface SchemaTable {
  columns: SchemaColumn[];
  foreignKeys: { from: string; table: string; to: string }[];
  name: string;
}

export type SchemaNode = Node<
  { table: SchemaTable; onSelect: (name: string) => void },
  "databaseSchema"
>;

// Adapted from React Flow UI's Database Schema Node (MIT). The table and
// handle structure is retained; styling uses Saqi's existing design tokens.
function DatabaseSchemaNode({ children }: { children: ReactNode }) {
  return <section className="schema-node">{children}</section>;
}

function DatabaseSchemaNodeHeader({ children }: { children: ReactNode }) {
  return <div className="schema-node-header">{children}</div>;
}

function DatabaseSchemaNodeBody({ children }: { children: ReactNode }) {
  return (
    <div className="schema-node-body">
      <table>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function DatabaseSchemaTableRow({ children }: { children: ReactNode }) {
  return <tr>{children}</tr>;
}

function DatabaseSchemaTableCell({ children }: { children: ReactNode }) {
  return <td>{children}</td>;
}

export function illustrativeValue(column: SchemaColumn, row: number): string {
  const name = column.name.toLowerCase();
  if (name.includes("url") || name.includes("href"))
    return `https://example.invalid/${String(row)}`;
  if (name.includes("hash") || name.includes("digest"))
    return String(row).repeat(64);
  if (name.includes("json") || name.includes("payload"))
    return JSON.stringify({ example: row });
  if (name.includes("arabic") || name.endsWith("_ar"))
    return `مثال ${String(row)}`;
  if (name.includes("_at") || name.includes("timestamp"))
    return String(1_750_000_000 + row * 86_400);
  if (name === "singleton") return "1";
  if (/INT|REAL|NUMERIC|BOOLEAN/i.test(column.type)) return String(row);
  if (name.endsWith("_id") || name === "id") return `example-${String(row)}`;
  if (name.includes("month")) return `2025-0${String(row)}-01`;
  return `example ${String(row)}`;
}

function SchemaNodeView({ data }: NodeProps<SchemaNode>) {
  const { table, onSelect } = data;
  return (
    <div>
      <DatabaseSchemaNode>
        <DatabaseSchemaNodeHeader>
          <button
            className="schema-node-title nodrag"
            onClick={() => onSelect(table.name)}
            type="button"
          >
            {table.name}
          </button>
        </DatabaseSchemaNodeHeader>
        <DatabaseSchemaNodeBody>
          {table.columns.map((column) => (
            <DatabaseSchemaTableRow key={column.name}>
              <DatabaseSchemaTableCell>
                <Handle
                  className="schema-handle"
                  id={`${column.name}-target`}
                  position={Position.Left}
                  type="target"
                />
                <span className="schema-column-name">{column.name}</span>
                {column.primaryKey ? (
                  <span className="schema-key" title="Primary key">
                    PK
                  </span>
                ) : null}
              </DatabaseSchemaTableCell>
              <DatabaseSchemaTableCell>
                <span className="schema-column-type">{column.type}</span>
                <Handle
                  className="schema-handle"
                  id={`${column.name}-source`}
                  position={Position.Right}
                  type="source"
                />
              </DatabaseSchemaTableCell>
            </DatabaseSchemaTableRow>
          ))}
        </DatabaseSchemaNodeBody>
      </DatabaseSchemaNode>
    </div>
  );
}

export default memo(SchemaNodeView);
