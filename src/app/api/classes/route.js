import { NextResponse } from 'next/server';
import { getClassesList } from '@/lib/pronote/store';

/** GET /api/classes — liste des classes disponibles (scrapées par le cron). */
export async function GET() {
  const classes = await getClassesList();
  return NextResponse.json({ classes: classes ?? [] });
}
