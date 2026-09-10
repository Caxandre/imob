import { Skeleton } from "@/components/ui/skeleton";

import { PropertyGallerySkeleton } from "./PropertyGallerySkeleton";

// Shown only while the property itself is still pending (Prompt 038, section 42) — a whole,
// non-broken layout, not partial content.
export function PropertyDetailsSkeleton() {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <Skeleton className="h-9 w-40" />
      <div className="grid gap-8 lg:grid-cols-2">
        <PropertyGallerySkeleton />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </main>
  );
}
