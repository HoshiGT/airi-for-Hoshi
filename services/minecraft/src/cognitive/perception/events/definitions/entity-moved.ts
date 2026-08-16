import { definePerceptionEvent } from '..'

interface EntityMovedExtract {
  entityType: 'player' | 'mob'
  entityId: string
  displayName?: string
  distance: number
  hasLineOfSight: boolean
  pos: any
}

export const entityMovedEvent = definePerceptionEvent<[any], EntityMovedExtract>({
  id: 'entity_moved',
  modality: 'sighted',
  kind: 'entity_moved',

  mineflayer: {
    event: 'entityMoved',
    filter: (ctx, entity) => {
      if (!entity)
        return false
      if (ctx.isSelf(entity))
        return false

      // NOTICE: reject non-players here, at the cheapest possible point.
      //
      // `entityMoved` fires for every entity within range on every movement packet — mobs, dropped
      // items, arrows, the lot. Each one that gets past this filter costs two nanoid calls, a
      // deepFreeze, an AsyncLocalStorage.run and a full pass over the rule set. And the only rule
      // that consumes this event requires `entityType: player`
      // (`cognitive/perception/rules/attention/movement.yaml`), so all of that work for mobs was
      // discarded at the very last step — 100% waste, at mob-movement frequency.
      //
      // Same shape as the guards in `fall-tracker.ts` (physicsTick, 20Hz) and `sneak-toggle.ts`
      // (entityUpdate), which likewise reject in the filter rather than downstream.
      if (entity.type !== 'player')
        return false

      const dist = ctx.distanceTo(entity)
      return dist !== null && dist <= ctx.maxDistance
    },
    extract: (ctx, entity) => ({
      entityType: entity?.type === 'player' ? 'player' : 'mob',
      entityId: ctx.entityId(entity),
      displayName: entity?.username,
      distance: ctx.distanceTo(entity)!,
      hasLineOfSight: true,
      pos: entity?.position,
    }),
  },

})
