import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <h1 className="text-2xl font-bold">Not found</h1>
      <p className="text-muted-foreground">
        This operations page does not exist.
      </p>
      <Link
        className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium whitespace-nowrap transition-all focus-visible:ring-3 focus-visible:outline-none"
        href="/"
      >
        Back to operations
      </Link>
    </div>
  );
}
