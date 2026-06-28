export interface ActionDefinition {
  id: string
  label: string
  requiresCourse: boolean
}

export interface ActionContext {
  hasCourse: boolean
  hasCourses: boolean
}

export const ACTION_REGISTRY: ActionDefinition[] = [
  { id: "switch_course", label: "Switch subject", requiresCourse: false },
  { id: "create_course", label: "Create subject", requiresCourse: false },
  { id: "add_materials", label: "Add materials", requiresCourse: true },
  { id: "configure_provider", label: "Configure provider", requiresCourse: false },
  { id: "view_progress", label: "View progress", requiresCourse: true },
  { id: "view_sources", label: "View sources", requiresCourse: true },
  { id: "make_plan", label: "Make plan / Replan", requiresCourse: true },
  { id: "exam_review", label: "Start exam review", requiresCourse: true },
  { id: "change_style", label: "Change style", requiresCourse: true },
  { id: "help", label: "Help", requiresCourse: false },
  { id: "quit", label: "Quit", requiresCourse: false },
]

export function filterActions(registry: ActionDefinition[], filter: string): ActionDefinition[] {
  if (!filter) return [...registry]
  const lower = filter.toLowerCase()
  return registry.filter((action) => action.label.toLowerCase().includes(lower))
}

export function isActionAvailable(action: ActionDefinition, context: ActionContext): boolean {
  if (!action.requiresCourse) return true
  return context.hasCourse
}
