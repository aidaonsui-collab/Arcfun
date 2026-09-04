import { ArcCreateForm } from '@/components/ArcCreateForm'

export const metadata = { title: 'Launch a token — Arcfun' }

export default function CreatePage() {
  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-[1120px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <ArcCreateForm />
      </div>
    </main>
  )
}
