import AdminTemplatesSection from './AdminTemplatesSection'

// /admin/templates — the reply-template editor as its own admin tab.
// AdminTemplatesSection owns all the load / save / audit behaviour;
// this wrapper just adds the page-level heading the other admin tabs
// use.

export default function AdminTemplatesPage() {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-ink">Templates</h2>
        <p className="mt-1 text-sm text-ink-mute">
          The message bodies sent to customers — designer-composed proof messages, automatic confirmations, and needs-attention reminders. Changes save automatically.
        </p>
      </div>

      <AdminTemplatesSection />
    </div>
  )
}
