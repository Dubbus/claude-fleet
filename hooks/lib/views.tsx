// What the pane and the band draw. These get the surface's elements and plain callbacks, never `$`:
// the engine only follows `$` within register.tsx, so everything that touches it stays there.
import type { ElementTable, UiPressArgument } from 'claude-code'

import type { Band, Snapshot } from '../../types'

import {
  ago, basename, ctxText, fit, fitLabel, gitText, glyph, label, summaryParts, tokensText, VALUE_COLOR,
} from './format.ts'
import { isCold, isStale, needsYou, windowCounts } from './rules.ts'

export type PaneActions = {
  select: (key: string) => void
  handoff: () => void
  save: () => void
  close: () => void
  copy: (press: UiPressArgument) => void
  refresh: () => void
}

export type PaneView = {
  snap: Snapshot | null
  picked: string | null
  closing: string | null
  // The pane body's width and the viewport's height, in cells.
  columns: number
  rows: number
}

export const paneView = (el: ElementTable, view: PaneView, act: PaneActions) => {
  const { Box, Button, Text } = el
  const { snap, picked, closing } = view
  if (!snap) return <Text dimColor>Scanning…</Text>

  const now = snap.scannedAt
  const counts = windowCounts(snap.rows)
  const hasGit = snap.rows.some(r => r.git)
  const [headline, details] = summaryParts(snap)
  const ctxW = 10
  const projW = Math.max(8, Math.min(20, Math.floor(view.columns * 0.16)))
  const gitW = hasGit ? Math.max(6, Math.min(22, Math.floor(view.columns * 0.2))) : 0
  const nameW = Math.max(10, view.columns - 4 - 9 - projW - gitW - 5 - ctxW - 5)
  const room = Math.max(1, view.rows - 7)

  return (
    <Box flexDirection="column">
      {snap.warning ? <Text color="red" wrap="wrap">⚠ {snap.warning}</Text> : null}
      <Text bold wrap="truncate-end">{headline}</Text>
      {details ? <Text dimColor wrap="truncate-end">{details}</Text> : null}
      <Text> </Text>
      {snap.rows.slice(0, room).map((r, i) => {
        const isPicked = r.key === picked
        const stale = r.pid !== null && isStale(r, now)
        const color = r.status === 'busy' ? 'yellow' : needsYou(r.status) && r.pid !== null ? 'red' : undefined
        const cold = r.tokens !== null && isCold(r, now)
        return (
          <Box key={r.key}>
            <Button
              key={`row:${r.key}`}
              plain
              label={isPicked ? '▸' : r.isSelf ? '•' : ' '}
              autoFocus={i === 0 && picked === null ? true : undefined}
              onPress={() => act.select(r.key)}
            />
            <Text color={r.value ? VALUE_COLOR[r.value] : undefined} dimColor={r.value === 'light'}>{` ${glyph(r)} `}</Text>
            {r.key === closing ? (
              <Text color="red" bold wrap="truncate-end">{fit(`x to close: ${label(r)}`, nameW)} </Text>
            ) : (
              <Text bold={r.isSelf || isPicked} inverse={isPicked} color={r.isSelf ? 'cyan' : undefined} dimColor={stale && !isPicked} wrap="truncate-end">
                {fitLabel(r, counts, nameW)}
              </Text>
            )}
            <Text> </Text>
            <Text color={color} dimColor={!color}>{fit(r.status, 9)}</Text>
            <Text dimColor={stale}>{fit(basename(r.cwd), projW)} </Text>
            {hasGit ? (
              <Text color={r.git?.dirty ? 'magenta' : undefined} dimColor={!r.git || stale}>{fit(gitText(r.git), gitW)}</Text>
            ) : null}
            <Text dimColor>{(r.pid === null ? '' : ago(now - r.updatedAt)).padStart(4)} </Text>
            <Text color={cold && (r.tokens ?? 0) >= 500_000 ? 'red' : cold ? 'blue' : undefined} dimColor={!cold}>
              {ctxText(r, now).padStart(ctxW)}
            </Text>
          </Box>
        )
      })}
      {snap.rows.length > room ? <Text dimColor>  +{snap.rows.length - room} more (/fleet list)</Text> : null}
      <Text> </Text>
      <Box>
        <Button key="handoff" label="Handoff" hotkey="h" onPress={act.handoff} />
        <Text> </Text>
        <Button key="save" label="Save" hotkey="s" onPress={act.save} />
        <Text> </Text>
        <Button key="close" label="Close" hotkey="x" onPress={act.close} />
        <Text> </Text>
        <Button key="copy" label="Copy resume" hotkey="c" onPress={act.copy} />
        <Text> </Text>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={act.refresh} />
      </Box>
      <Text dimColor wrap="truncate-end">● in progress  ◐ finished: hand off  ○ light · ctx = tokens a resume re-caches · cold = cache expired</Text>
    </Box>
  )
}

export type BandActions = {
  handOff: (then: 'fresh' | 'exit' | null) => void
  startFresh: (path: string) => void
  exitNow: () => void
  later: (tokens: number) => void
  dismiss: () => void
}

export const bandView = (el: ElementTable, offer: Band, act: BandActions) => {
  const { Box, Button, Text } = el

  if (offer.kind === 'working') return <Text dimColor>⧉ {offer.text}</Text>

  if (offer.kind === 'handedOff') {
    return (
      <Box flexDirection="column">
        <Text color="green" wrap="truncate-end">⧉ Handoff written: {basename(offer.path)}</Text>
        <Box>
          <Button key="fresh" label="Start fresh from it" hotkey="f" variant="primary" onPress={() => act.startFresh(offer.path)} />
          <Text> </Text>
          <Button key="keep" label="Keep going here" hotkey="k" onPress={act.dismiss} />
        </Box>
      </Box>
    )
  }

  if (offer.kind === 'exit') {
    const why = offer.value === 'active' ? 'is still in progress' : `holds ${tokensText(offer.tokens)} tokens`
    return (
      <Box flexDirection="column">
        <Text color="yellow" wrap="truncate-end">⧉ Before you go: this session {why}. A handoff keeps it for next time.</Text>
        <Box>
          <Button key="handoff-exit" label="Hand off and exit" hotkey="h" variant="primary" onPress={() => act.handOff('exit')} />
          <Text> </Text>
          <Button key="exit-now" label="Exit now" hotkey="e" onPress={act.exitNow} />
          <Text> </Text>
          <Button key="stay" label="Stay" hotkey="s" onPress={act.dismiss} />
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text color="yellow" wrap="truncate-end">
        ⧉ This session is carrying {tokensText(offer.tokens)} tokens. A handoff lets a fresh session continue from about 3k.
      </Text>
      <Box>
        <Button key="handoff-fresh" label="Hand off and start fresh" hotkey="h" variant="primary" onPress={() => act.handOff('fresh')} />
        <Text> </Text>
        <Button key="handoff-only" label="Just write it" hotkey="w" onPress={() => act.handOff(null)} />
        <Text> </Text>
        <Button key="later" label="Later" hotkey="l" onPress={() => act.later(offer.tokens)} />
      </Box>
    </Box>
  )
}
