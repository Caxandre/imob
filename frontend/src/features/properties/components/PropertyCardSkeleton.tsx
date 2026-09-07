import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function PropertyCardSkeleton() {
  return (
    <Card>
      <Skeleton className="aspect-4/3 w-full rounded-none" />
      <CardHeader>
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-6 w-1/3" />
      </CardContent>
    </Card>
  );
}
