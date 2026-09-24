import "@xyflow/react/dist/style.css";
import "./schema-explorer.css";

import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useMemo, useState } from "react";

import SchemaNodeView, {
  illustrativeValue,
  type SchemaNode,
  type SchemaTable,
} from "./database-schema-node";

interface SchemaDatabase {
  id: string;
  label: string;
  tables: SchemaTable[];
}
interface Catalog {
  databases: SchemaDatabase[];
  localVersion: number;
  migrationNames: string[];
}
const NODE_TYPES = { databaseSchema: SchemaNodeView } as const;

function positionTables(
  tables: SchemaTable[],
  onSelect: (name: string) => void,
): SchemaNode[] {
  let y = 0;
  return tables.flatMap((table, index) => {
    if (index % 4 === 0 && index > 0) {
      const previous = tables.slice(index - 4, index);
      y +=
        Math.max(...previous.map((item) => 80 + item.columns.length * 29)) +
        110;
    }
    return [
      {
        id: table.name,
        type: "databaseSchema" as const,
        position: { x: (index % 4) * 390, y },
        data: { table, onSelect },
        draggable: false,
      },
    ];
  });
}

export default function SchemaExplorer({ catalog }: { catalog: Catalog }) {
  const initialDatabase = catalog.databases[0];
  if (!initialDatabase) throw new Error("DATABASE_SCHEMA_EMPTY");
  const [databaseId, setDatabaseId] = useState(initialDatabase.id);
  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState<null | string>(
    initialDatabase.tables[0]?.name ?? null,
  );
  const [detailView, setDetailView] = useState<"columns" | "examples">(
    "columns",
  );
  const [flow, setFlow] = useState<null | ReactFlowInstance<SchemaNode>>(null);
  const database =
    catalog.databases.find((item) => item.id === databaseId) ?? initialDatabase;
  const matches = useMemo(
    () =>
      database.tables.filter(
        (table) =>
          table.name.toLowerCase().includes(query.trim().toLowerCase()) ||
          table.columns.some((column) =>
            column.name.toLowerCase().includes(query.trim().toLowerCase()),
          ),
      ),
    [database, query],
  );
  const selected = matches.find((table) => table.name === selectedName) ?? null;
  const select = useCallback(
    (name: string) => {
      setSelectedName(name);
      setDetailView("columns");
      requestAnimationFrame(
        () =>
          void flow?.fitView({
            nodes: [{ id: name }],
            duration: 300,
            padding: 0.55,
          }),
      );
    },
    [flow],
  );
  const nodes = useMemo(
    () => positionTables(matches, select),
    [matches, select],
  );
  const visible = new Set(matches.map((table) => table.name));
  const edges: Edge[] = matches.flatMap((table) =>
    table.foreignKeys
      .filter((key) => visible.has(key.table))
      .map((key) => ({
        id: `${table.name}.${key.from}-${key.table}.${key.to}`,
        source: table.name,
        sourceHandle: `${key.from}-source`,
        target: key.table,
        targetHandle: `${key.to}-target`,
        type: "smoothstep",
        animated: false,
      })),
  );

  return (
    <div className="schema-explorer">
      <div aria-label="Database" className="schema-toolbar" role="group">
        {catalog.databases.map((item) => (
          <button
            aria-pressed={item.id === databaseId}
            key={item.id}
            onClick={() => {
              setDatabaseId(item.id);
              setSelectedName(item.tables[0]?.name ?? null);
              setDetailView("columns");
              setQuery("");
              setFlow(null);
            }}
            type="button"
          >
            {item.label} <span>{item.tables.length}</span>
          </button>
        ))}
      </div>
      <div className="schema-workspace">
        <aside aria-label="Tables" className="schema-index">
          <label htmlFor="schema-search">Find a table or column</label>
          <input
            id="schema-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search schema"
            type="search"
            value={query}
          />
          <p>
            {matches.length} of {database.tables.length} tables
          </p>
          <output aria-live="polite" className="visually-hidden" role="status">
            {matches.length} matching tables
          </output>
          <div className="schema-table-list" key={databaseId}>
            {matches.map((table) => (
              <button
                aria-current={selectedName === table.name ? "true" : undefined}
                key={table.name}
                onClick={() => select(table.name)}
                type="button"
              >
                <span>{table.name}</span>
                <small>{table.columns.length} columns</small>
              </button>
            ))}
            {matches.length === 0 ? (
              <p>No matching tables or columns.</p>
            ) : null}
          </div>
        </aside>
        <div
          aria-label={`${database.label} relationship diagram`}
          className="schema-canvas"
        >
          <ReactFlow<SchemaNode>
            defaultViewport={{ x: 24, y: 24, zoom: 0.72 }}
            edges={edges}
            elementsSelectable
            key={databaseId}
            maxZoom={1.5}
            minZoom={0.12}
            nodes={nodes}
            nodesConnectable={false}
            nodeTypes={NODE_TYPES}
            onInit={setFlow}
            onNodeClick={(_event, node) => select(node.id)}
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={22} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
          {query.trim() ? (
            <p className="schema-filter-note">
              Relationships between matching tables
            </p>
          ) : null}
        </div>
        <section className="schema-inspector">
          {selected ? (
            <>
              <div className="schema-inspector-title">
                <h2>{selected.name}</h2>
                <span>
                  {selected.columns.length} columns ·{" "}
                  {selected.foreignKeys.length} foreign keys
                </span>
              </div>
              <div
                aria-label="Table details"
                className="schema-detail-tabs"
                role="group"
              >
                <button
                  aria-pressed={detailView === "columns"}
                  onClick={() => setDetailView("columns")}
                  type="button"
                >
                  Columns
                </button>
                <button
                  aria-pressed={detailView === "examples"}
                  onClick={() => setDetailView("examples")}
                  type="button"
                >
                  5 example rows
                </button>
              </div>
              {detailView === "columns" ? (
                <div className="schema-detail-content">
                  <table>
                    <thead>
                      <tr>
                        <th>Column</th>
                        <th>Type</th>
                        <th>Constraint</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.columns.map((column) => (
                        <tr key={column.name}>
                          <th scope="row">{column.name}</th>
                          <td>{column.type}</td>
                          <td>
                            {column.primaryKey
                              ? "Primary key"
                              : column.nullable
                                ? "Nullable"
                                : "Required"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="schema-detail-content">
                  <p>Illustrative data</p>
                  <div className="schema-inspector-samples">
                    <table>
                      <thead>
                        <tr>
                          {selected.columns.map((column) => (
                            <th key={column.name}>{column.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[1, 2, 3, 4, 5].map((row) => (
                          <tr key={row}>
                            {selected.columns.map((column) => (
                              <td key={column.name}>
                                {illustrativeValue(column, row)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p>Select a table to inspect its columns and examples.</p>
          )}
        </section>
      </div>
    </div>
  );
}
