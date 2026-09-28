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
