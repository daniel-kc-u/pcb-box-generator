// ============================================================================
// Parametric PCB Enclosure Generator (OpenJSCAD V2 / @jscad/modeling)
// ============================================================================
// Generates a two-piece, print-friendly PCB enclosure:
//   - Parametric PCB footprint (length, width, thickness)
//   - Screw bosses at arbitrary (x,y) positions to secure the PCB
//   - Rectangular side-wall cutouts (ports) at arbitrary positions on any
//     of the 4 walls, for connectors/switches/LEDs etc.
//
// PRINT-OPTIMIZED SIDE PORTS
//   A rectangular hole cut into a single tall wall needs its "roof" (the
//   solid material above the opening) to bridge across the gap with
//   nothing beneath it -- fine for small openings, but it sags or fails
//   on wide/tall connector cutouts (barrel jacks, HDMI, wide header
//   cutouts, etc).
//
//   This script avoids that entirely: the box and lid are split at a
//   configurable parting-line height (`splitHeight`). Any port whose
//   Z-range crosses that line is automatically divided in two --
//     - the box gets the lower portion, cut so it is open at the box's
//       top rim (nothing above it -> no bridge to print)
//     - the lid gets the upper portion, cut so it is open at the lid's
//       bottom rim (nothing below it -> no bridge to print, in either
//       print orientation)
//   The two halves line up into one continuous opening once assembled.
//   Ports that don't cross the parting line are cut as ordinary single
//   openings (same bridging behavior as any normal enclosure) -- for the
//   optimization to kick in, size/position a port (or set `splitHeight`)
//   so it straddles the line.
//
// Run with the OpenJSCAD CLI (`jscad pcb-enclosure-generator.js`), the
// OpenJSCAD desktop app, or paste into openjscad.xyz. All units are mm.
//
// COORDINATE SYSTEM
//   Origin (0,0) is the center of the PCB footprint in X/Y. Z=0 is the
//   bottom (outside) of the box floor. The PCB sits flat, oriented with
//   its length along X and width along Y.
//
// PARTING LINE
//   The box's wall ends at Z = splitHeight (its top rim); the lid's wall
//   starts there too and sits flush on top -- a plain butt joint with no
//   separate alignment feature. The lid-fastening screws (below) are what
//   hold the two halves together and keep them registered.
//
// LID FASTENING SCREWS
//   Separate from the PCB-mounting bosses, `fastenerPositions` places one
//   or more screw columns that hold the box and lid together. Each one is:
//     - a boss in the box, floor to just below its top rim, with a blind
//       tap hole bored down from its top (self-tapping screw)
//     - a matching clearance hole straight through the lid, with a flat-
//       bottomed cylindrical counterbore at the outer top surface sized
//       to the screw head -- suited to machine screws / hex socket-head
//       (Allen) screws, which have a flat-bottomed head rather than a
//       tapered one
//
// LID TOP OPENINGS (jumper cable / wire pass-throughs)
//   Independent of the side ports above, the lid's flat top cap can have
//   its own set of rectangular pass-through openings for jumper wires,
//   cable bundles, antenna pigtails, etc. that need to exit straight up
//   rather than out a side wall. Each entry is "x,y,width,height", with
//   x,y relative to the PCB center (same convention as boss positions).
//   These are cut straight through the lid's solid top cap only -- the
//   cavity below it is already open, so no bridging concern applies here.
//
// WALL NUMBERING (used by the "portOpenings" parameter)
//   0 = front wall  (-Y face)
//   1 = right wall  (+X face)
//   2 = back wall   (+Y face)
//   3 = left wall   (-X face)
//   "pos" for an opening is measured along that wall from its CENTER
//   (positive = toward +X for front/back walls, toward +Y for left/right
//   walls). "zOffset" and "height" are absolute, measured from the box
//   floor (Z=0) regardless of which side of the parting line they fall on.
// ============================================================================

const { primitives, booleans, transforms, colors } = require('@jscad/modeling')
const { cuboid, cylinder } = primitives
const { union, subtract } = booleans
const { translate } = transforms
const { colorize } = colors

// Small overlap used at internal boolean seams to avoid coincident-face
// artifacts ("z-fighting") in the CSG kernel, and to guarantee split
// port cutouts are fully open (no stray membrane) at the parting line.
const EPS = 0.02

// Minimum solid floor thickness to always leave under any blind screw
// hole, regardless of how deep the caller asks for -- keeps hole depth
// parameters from accidentally punching through the outside of the floor.
const MIN_FLOOR_REMAINING = 1

// ----------------------------------------------------------------------------
// Parameter UI
// ----------------------------------------------------------------------------
const getParameterDefinitions = () => [
  { name: 'gPcb', type: 'group', caption: 'PCB Dimensions' },
  { name: 'pcbLength', type: 'float', initial: 60, caption: 'PCB Length, X (mm)' },
  { name: 'pcbWidth', type: 'float', initial: 40, caption: 'PCB Width, Y (mm)' },
  { name: 'pcbThickness', type: 'float', initial: 1.6, caption: 'PCB Thickness, Z (mm)' },

  { name: 'gFit', type: 'group', caption: 'Fit & Clearance' },
  { name: 'pcbClearance', type: 'float', initial: 0.5, caption: 'Clearance around PCB edges (mm)' },
  { name: 'standoffHeight', type: 'float', initial: 3, caption: 'Standoff/boss height under PCB (mm)' },
  { name: 'topClearance', type: 'float', initial: 6, caption: 'Clearance above PCB/components (mm)' },

  { name: 'gShell', type: 'group', caption: 'Walls & Shell' },
  { name: 'wallThickness', type: 'float', initial: 2, caption: 'Wall thickness (mm)' },
  { name: 'floorThickness', type: 'float', initial: 2, caption: 'Floor thickness (mm)' },
  { name: 'lidCeilingThickness', type: 'float', initial: 2, caption: 'Lid ceiling (top cap) thickness (mm)' },
  { name: 'circleSegments', type: 'int', initial: 32, caption: 'Circle/round resolution' },

  { name: 'gSplit', type: 'group', caption: 'Box / Lid Parting Line' },
  {
    name: 'splitHeight',
    type: 'float',
    initial: 9.5,
    caption: 'Parting line height, from floor (mm) -- place it through tall ports to avoid bridging'
  },

  { name: 'gBoss', type: 'group', caption: 'Screw Bosses' },
  { name: 'bossOuterDiameter', type: 'float', initial: 6, caption: 'Boss outer diameter (mm)' },
  { name: 'bossHoleDiameter', type: 'float', initial: 2.6, caption: 'Boss screw-hole diameter (mm)' },
  { name: 'bossHoleDepth', type: 'float', initial: 6, caption: 'Boss hole depth, from boss top (mm) -- clamped to stay blind' },
  {
    name: 'bossPositions',
    type: 'text',
    initial: '-20,-12;20,-12;-20,12;20,12',
    caption: 'Boss positions "x,y;x,y;..." relative to PCB center (mm) -- keep clear of fastener positions below'
  },

  { name: 'gFastener', type: 'group', caption: 'Lid Fastening Screws' },
  {
    name: 'fastenerPositions',
    type: 'text',
    initial: '-28,-18;28,-18;-28,18;28,18',
    caption: 'Fastener positions "x,y;x,y;..." relative to PCB center (mm)'
  },
  { name: 'fastenerBossDiameter', type: 'float', initial: 7, caption: 'Fastener boss outer diameter (mm)' },
  { name: 'fastenerTapHoleDiameter', type: 'float', initial: 2.6, caption: 'Fastener tap-hole diameter, in box boss (mm)' },
  { name: 'fastenerTapHoleDepth', type: 'float', initial: 4, caption: 'Fastener tap-hole depth, from boss top (mm) -- clamped to stay blind' },
  { name: 'fastenerScrewClearanceDiameter', type: 'float', initial: 3.4, caption: 'Fastener shaft clearance diameter, through lid (mm)' },
  { name: 'fastenerHeadDiameter', type: 'float', initial: 6, caption: 'Fastener screw head / counterbore diameter (mm)' },
  { name: 'fastenerCountersinkDepth', type: 'float', initial: 1.8, caption: 'Counterbore depth, from lid outer surface (mm)' },

  { name: 'gPorts', type: 'group', caption: 'Side Port Openings' },
  {
    name: 'portOpenings',
    type: 'text',
    initial: '0,0,16,10,5;2,-14,10,8,4;1,0,8,14,2',
    caption:
      'Ports "side,pos,width,height,zOffset;..." (0=front -Y, 1=right +X, 2=back +Y, 3=left -X). ' +
      'Ports crossing the parting line are auto-split between box and lid.'
  },

  { name: 'gLidTop', type: 'group', caption: 'Lid Top Openings (Jumper/Wire Pass-Throughs)' },
  {
    name: 'lidTopOpenings',
    type: 'text',
    initial: '0,-12,10,6;18,8,6,10',
    caption:
      'Lid top openings "x,y,width,height;..." (rectangular). x,y relative to PCB center (mm)'
  },

  { name: 'gOutput', type: 'group', caption: 'Output' },
  { name: 'showBox', type: 'checkbox', checked: true, caption: 'Show box' },
  { name: 'showLid', type: 'checkbox', checked: true, caption: 'Show lid' },
  { name: 'explodedView', type: 'checkbox', checked: true, caption: 'Lift lid for viewing (not for export/print)' },
  { name: 'explodeDistance', type: 'float', initial: 15, caption: 'Lid lift distance (mm)' }
]

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// Parses a "a,b,c;d,e,f;..." string into [[a,b,c],[d,e,f],...] of numbers.
const parseRows = (str) =>
  String(str || '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((row) => row.split(',').map((n) => parseFloat(n.trim())))

const isValidRow = (row) => row.every((n) => Number.isFinite(n))

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
const main = (params) => {
  const {
    pcbLength, pcbWidth, pcbThickness,
    pcbClearance, standoffHeight, topClearance,
    wallThickness, floorThickness, lidCeilingThickness, circleSegments,
    splitHeight,
    bossOuterDiameter, bossHoleDiameter, bossHoleDepth, bossPositions,
    fastenerPositions, fastenerBossDiameter,
    fastenerTapHoleDiameter, fastenerTapHoleDepth,
    fastenerScrewClearanceDiameter, fastenerHeadDiameter, fastenerCountersinkDepth,
    portOpenings,
    lidTopOpenings,
    showBox, showLid, explodedView, explodeDistance
  } = params

  // ---- derived footprint dimensions ----
  const innerLength = pcbLength + 2 * pcbClearance   // PCB compartment, X
  const innerWidth = pcbWidth + 2 * pcbClearance      // PCB compartment, Y
  const outerLength = innerLength + 2 * wallThickness // outside of shell, X
  const outerWidth = innerWidth + 2 * wallThickness   // outside of shell, Y

  // ---- key Z heights ----
  const pcbZBottom = floorThickness + standoffHeight   // bottom face of PCB
  const pcbZTop = pcbZBottom + pcbThickness              // top face of PCB
  const totalHeight = pcbZTop + topClearance + lidCeilingThickness // full assembled height
  const ceilingBottomZ = totalHeight - lidCeilingThickness           // underside of the lid's top cap

  // Parting line between box and lid, clamped so both shells always have
  // enough material to work with.
  const splitZ = Math.min(Math.max(splitHeight, floorThickness + 1), ceilingBottomZ - 0.5)

  // ==========================================================================
  // BOX -- floor to splitZ
  // ==========================================================================
  let boxOuter = translate([0, 0, splitZ / 2], cuboid({ size: [outerLength, outerWidth, splitZ] }))

  // Main PCB cavity: floor up to the box's top rim
  const mainCavityHeight = (splitZ - floorThickness) + EPS
  const mainCavity = translate(
    [0, 0, floorThickness + mainCavityHeight / 2],
    cuboid({ size: [innerLength, innerWidth, mainCavityHeight] })
  )

  let box = subtract(boxOuter, mainCavity)

  // ---- screw bosses (solid posts + coaxial screw holes) ----
  const bossRadius = bossOuterDiameter / 2
  const holeRadius = bossHoleDiameter / 2
  const bossTopZ = floorThickness + standoffHeight

  parseRows(bossPositions).forEach((row) => {
    if (!isValidRow(row) || row.length < 2) return
    const [x, y] = row

    const bossSolid = translate(
      [x, y, floorThickness + standoffHeight / 2],
      cylinder({ radius: bossRadius, height: standoffHeight, segments: circleSegments })
    )
    box = union(box, bossSolid)

    // Blind hole bored down from the top of the boss. Clamped so it never
    // punctures the outside of the floor -- at least MIN_FLOOR_REMAINING
    // of solid material is always left underneath it.
    const maxHoleDepth = Math.max(bossTopZ - MIN_FLOOR_REMAINING, 0.5)
    const holeDepth = Math.min(bossHoleDepth, maxHoleDepth) + EPS
    const holeSolid = translate(
      [x, y, bossTopZ - holeDepth / 2],
      cylinder({ radius: holeRadius, height: holeDepth, segments: circleSegments })
    )
    box = subtract(box, holeSolid)
  })

  // ==========================================================================
  // LID -- splitZ to totalHeight (wall + solid top cap)
  // ==========================================================================
  const lidSpan = totalHeight - splitZ
  let lidOuter = translate([0, 0, splitZ + lidSpan / 2], cuboid({ size: [outerLength, outerWidth, lidSpan] }))

  // Hollow out the lid's wall section only (splitZ..ceilingBottomZ),
  // leaving the top cap (ceilingBottomZ..totalHeight) solid
  const lidCavityHeight = (ceilingBottomZ - splitZ) + EPS
  const lidCavity = translate(
    [0, 0, (splitZ - EPS) + lidCavityHeight / 2],
    cuboid({ size: [innerLength, innerWidth, lidCavityHeight] })
  )
  let lid = subtract(lidOuter, lidCavity)

  // ==========================================================================
  // LID FASTENING SCREWS -- bosses in the box + matching clearance holes
  // with a cylindrical counterbore in the lid, so the two halves can be
  // screwed together with machine/hex socket-head screws.
  // ==========================================================================
  const fastenerBossRadius = fastenerBossDiameter / 2
  const fastenerTapRadius = fastenerTapHoleDiameter / 2
  const fastenerShaftRadius = fastenerScrewClearanceDiameter / 2
  const fastenerHeadRadius = fastenerHeadDiameter / 2
  const fastenerBossHeight = Math.max(splitZ - floorThickness, 1)
  const fastenerBossTopZ = floorThickness + fastenerBossHeight

  parseRows(fastenerPositions).forEach((row) => {
    if (!isValidRow(row) || row.length < 2) return
    const [x, y] = row

    // --- box side: solid boss standing on the floor, up to the cavity ceiling ---
    const bossSolid = translate(
      [x, y, floorThickness + fastenerBossHeight / 2],
      cylinder({ radius: fastenerBossRadius, height: fastenerBossHeight, segments: circleSegments })
    )
    box = union(box, bossSolid)

    // blind tap hole bored down from the top of the boss, for a self-
    // tapping screw. Clamped the same way as the PCB bosses above, so it
    // never punctures the outside of the floor even if the boss is short.
    const maxTapDepth = Math.max(fastenerBossTopZ - MIN_FLOOR_REMAINING, 0.5)
    const tapDepth = Math.min(fastenerTapHoleDepth, maxTapDepth) + EPS
    const tapHole = translate(
      [x, y, fastenerBossTopZ - tapDepth / 2],
      cylinder({ radius: fastenerTapRadius, height: tapDepth, segments: circleSegments })
    )
    box = subtract(box, tapHole)

    // --- lid side: through clearance shaft ... ---
    const shaftBottomZ = splitZ - EPS
    const shaftTopZ = totalHeight - fastenerCountersinkDepth
    const shaftHeight = Math.max(shaftTopZ - shaftBottomZ, EPS)
    const shaft = translate(
      [x, y, shaftBottomZ + shaftHeight / 2],
      cylinder({ radius: fastenerShaftRadius, height: shaftHeight, segments: circleSegments })
    )
    lid = subtract(lid, shaft)

    // ... plus a flat-bottomed cylindrical counterbore at the outer top
    // surface, sized to the screw head, so a machine/hex socket-head screw
    // sits flush (or recessed) when driven home
    const counterbore = translate(
      [x, y, shaftTopZ + fastenerCountersinkDepth / 2],
      cylinder({ radius: fastenerHeadRadius, height: fastenerCountersinkDepth + EPS, segments: circleSegments })
    )
    lid = subtract(lid, counterbore)
  })

  // ==========================================================================
  // SIDE PORTS -- auto-split across the box/lid parting line
  // ==========================================================================
  const cutDepth = wallThickness * 4 // generous depth, guarantees a clean through-cut

  const makeCutter = (side, pos, width, zLow, zHigh) => {
    const h = zHigh - zLow
    if (h <= 0) return null
    const zCenter = zLow + h / 2
    if (side === 0) return translate([pos, -outerWidth / 2, zCenter], cuboid({ size: [width, cutDepth, h] })) // front, -Y
    if (side === 2) return translate([pos, outerWidth / 2, zCenter], cuboid({ size: [width, cutDepth, h] }))  // back, +Y
    if (side === 1) return translate([outerLength / 2, pos, zCenter], cuboid({ size: [cutDepth, width, h] })) // right, +X
    if (side === 3) return translate([-outerLength / 2, pos, zCenter], cuboid({ size: [cutDepth, width, h] })) // left, -X
    return null
  }

  parseRows(portOpenings).forEach((row) => {
    if (!isValidRow(row) || row.length < 5) return
    const [side, pos, width, height, zOff] = row
    const zLow = zOff
    const zHigh = zOff + height

    // --- portion below the parting line: cut into the box ---
    const boxZLow = Math.max(zLow, 0)
    const boxZHigh = Math.min(zHigh, splitZ)
    if (boxZHigh > boxZLow) {
      // If the port reaches (or exceeds) the parting line, extend the cut
      // a hair past it so the box's top rim is fully open there -- no
      // "roof" is left to bridge when printing.
      const reachesSplit = zHigh >= splitZ
      const cutter = makeCutter(side, pos, width, boxZLow, reachesSplit ? boxZHigh + EPS : boxZHigh)
      if (cutter) box = subtract(box, cutter)
    }

    // --- portion above the parting line: cut into the lid ---
    const lidZLow = Math.max(zLow, splitZ)
    const lidZHigh = Math.min(zHigh, ceilingBottomZ) // never cut into the solid top cap
    if (lidZHigh > lidZLow) {
      // If the port starts at or below the parting line, extend the cut
      // a hair below it so the lid's bottom rim is fully open there.
      const reachesSplit = zLow <= splitZ
      const cutter = makeCutter(side, pos, width, reachesSplit ? lidZLow - EPS : lidZLow, lidZHigh)
      if (cutter) lid = subtract(lid, cutter)
    }
  })

  // ==========================================================================
  // LID TOP OPENINGS
  // ==========================================================================
  const capCutHeight = lidCeilingThickness + EPS * 2
  const capCutZ = (ceilingBottomZ - EPS) + capCutHeight / 2

  parseRows(lidTopOpenings).forEach((row) => {
    if (!isValidRow(row) || row.length < 4) return
    const [x, y, width, height] = row
    const cutter = translate([x, y, capCutZ], cuboid({ size: [width, height, capCutHeight] }))
    lid = subtract(lid, cutter)
  })

  // For viewing only: lift the lid clear of the box so both parts are
  // visible at once. Turn this off before exporting STLs for printing.
  if (explodedView) {
    lid = translate([0, 0, explodeDistance], lid)
  }

  // ---- assemble output ----
  const parts = []
  if (showBox) parts.push(colorize([0.55, 0.55, 0.6], box))
  if (showLid) parts.push(colorize([0.25, 0.55, 0.85, 0.85], lid))

  return parts
}

module.exports = { getParameterDefinitions, main }
