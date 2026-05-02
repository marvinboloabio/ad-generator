import { NextRequest } from 'next/server'
import { getJob } from '@/lib/jobStore'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const job = getJob(id)
  if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })
  return Response.json(job)
}
