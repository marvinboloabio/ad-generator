import { Job } from '@/types'

const jobs = new Map<string, Job>()

export function createJob(partial: Omit<Job, 'id' | 'createdAt' | 'updatedAt'>): Job {
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const now = new Date().toISOString()
  const job: Job = { id, ...partial, createdAt: now, updatedAt: now }
  jobs.set(id, job)
  return job
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  const job = jobs.get(id)
  if (!job) return undefined
  const updated = { ...job, ...patch, updatedAt: new Date().toISOString() }
  jobs.set(id, updated)
  return updated
}

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
}
