import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/**
 * Temporary landing page (this task, section 21) — proves the toolchain (React, Tailwind,
 * shadcn/ui) works end to end. Never a business dashboard: no property/tenant data, no API
 * call (section 73) — a future feature adds real content here or replaces this page entirely.
 */
export function HomePage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Imob</CardTitle>
          <CardDescription>Frontend foundation is ready.</CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="flex items-center justify-between">
          <Button>shadcn/ui</Button>
          <Badge variant="secondary">ready</Badge>
        </CardContent>
      </Card>
    </main>
  );
}
