// ============================================================================
// Parametric PCB Enclosure Generator (OpenJSCAD V2 / @jscad/modeling)
// ============================================================================
// Generates a two-piece, print-friendly PCB enclosure:
//   - Parametric PCB footprint (length, width, thickness)
//   - Rectangular side-wall cutouts at arbitrary positions on any
//     of the 4 walls, for ports/switches/LEDs etc.
//   - Top cutouts for jumper cable / wire pass-through
//   - Screw bosses at arbitrary (x,y) positions to secure the PCB
//   - Screw bosses to fasten the lid to the box body
//
// Run with the OpenJSCAD CLI (`jscad generator.js`), the OpenJSCAD
// desktop app, or paste into openjscad.xyz. All units are mm.
//
// COORDINATE SYSTEM
//   Origin (0,0) is the center of the PCB footprint in X/Y. Z=0 is the
//   bottom (outside) of the box floor. The PCB sits flat, oriented with
//   its length along X and width along Y.
//
// PRINT-OPTIMIZED SIDE OPENINGS (ports)
//   This script avoids overhang and the need for support: the box and lid
//   are split at a configurable parting-line height (`splitHeight`). Any
//   port whose Z-range crosses that line is automatically divided in two.
//     - the box gets the lower portion, cut so it is open at the box's
//       top rim
//     - the lid gets the upper portion, cut so it is open at the lid's
//       bottom rim
//   The two halves line up into one continuous opening once assembled.
//   Ports that don't cross the parting line are cut as ordinary single
//   openings. A future improvement is to allow the parting line to be
//   specified per opening.
//
// WALL NUMBERING (for side openings)
//   0 = front wall  (-Y face)
//   1 = right wall  (+X face)
//   2 = back wall   (+Y face)
//   3 = left wall   (-X face)
//   "pos" for an opening is measured along that wall from its CENTER
//   (positive = toward +X for front/back walls, toward +Y for left/right
//   walls). "zOffset" and "height" are absolute, measured from the box
//   floor (Z=0) regardless of which side of the parting line they fall on.
//
// LID TOP OPENINGS (jumper cable / wire pass-throughs)
//   Independent of the side openings above, the lid's flat top cap can have
//   its own set of rectangular pass-through openings for jumper wires,
//   cable bundles, antenna pigtails, etc. that need to exit straight up
//   rather than out a side wall. Each entry is "x,y,width,height", with
//   x,y relative to the PCB center (same convention as boss positions).
//
// PCB SCREW BOSSES
//   `pcbBossPositions` places a standoff post in the box floor at each
//   (x,y), rising `standoffHeight` up to the underside of the PCB, so the
//   board sits flat and clear of the floor. Each boss has a coaxial blind
//   screw hole bored down from its top (`pcbBossHoleDiameter` x
//   `pcbBossHoleDepth`) for a self-tapping screw driven up through a
//   mounting hole in the PCB -- clamped so it always leaves solid material
//   under it, the same way the fastener tap holes below do.
//
// LID FASTENING SCREW BOSSES / COUNTERBORE
//   Separate from the PCB-mounting bosses, `fastenerPositions` places one
//   or more screw columns that hold the box and lid together. Each one is:
//     - a boss in the box, floor to just below its top rim, with a blind
//       tap hole bored down from its top
//     - a matching clearance hole straight through the lid, with a flat-
//       bottomed cylindrical counterbore at the outer top surface sized
//       to the screw head -- suited to machine screws / hex socket-head
//       (Allen) screws, which have a flat-bottomed head rather than a
//       tapered one
// ============================================================================

const { primitives, booleans, transforms, colors, text: textApi, hulls, extrusions } = require('@jscad/modeling')
const { cuboid, cylinder, circle } = primitives
const { union, subtract } = booleans
const { translate, rotateZ } = transforms
const { colorize } = colors
const { vectorText } = textApi
const { hullChain } = hulls
const { extrudeLinear } = extrusions

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
  { name: 'gPcb', type: 'group', initial: 'closed', caption: 'PCB Dimensions' },
  { name: 'pcbLength', type: 'float', initial: 60, caption: 'PCB Length, X' },
  { name: 'pcbWidth', type: 'float', initial: 40, caption: 'PCB Width, Y' },
  { name: 'pcbThickness', type: 'float', initial: 1.6, caption: 'PCB Thickness, Z' },

  { name: 'gFit', type: 'group', initial: 'closed', caption: 'Fit & Clearance' },
  { name: 'pcbClearanceX', type: 'float', initial: 5, caption: 'Clearance around PCB edges, X' },
  { name: 'pcbClearanceY', type: 'float', initial: 5, caption: 'Clearance around PCB edges, Y' },
  { name: 'standoffHeight', type: 'float', initial: 3, caption: 'Standoff/boss height under PCB' },
  { name: 'topClearance', type: 'float', initial: 6, caption: 'Clearance above PCB/components' },

  { name: 'gShell', type: 'group', initial: 'closed', caption: 'Walls & Shell' },
  { name: 'wallThickness', type: 'float', initial: 2, caption: 'Wall thickness' },
  { name: 'floorThickness', type: 'float', initial: 2, caption: 'Floor thickness' },
  { name: 'lidCeilingThickness', type: 'float', initial: 2, caption: 'Lid ceiling thickness' },
  { name: 'circleSegments', type: 'int', initial: 32, caption: 'Circle/round resolution' },

  { name: 'gSplit', type: 'group', initial: 'closed', caption: 'Box / Lid Parting Line' },
  {
    name: 'splitHeight',
    type: 'float',
    initial: 9.5,
    caption: 'Parting line height, from floor -- place it through side openings to avoid bridging'
  },

  { name: 'gSideOpenings', type: 'group', initial: 'closed', caption: 'Side Openings' },
  {
    name: 'sideOpenings',
    type: 'text',
    initial: '0,0,16,10,5;2,-14,10,8,4;1,0,8,14,2',
    caption:
      '"side,pos,width,height,zOffset;..." (0=front -Y, 1=right +X, 2=back +Y, 3=left -X). ' +
      'Side openings crossing the parting line are auto-split between box and lid.'
  },

  { name: 'gTopOpenings', type: 'group', initial: 'closed', caption: 'Top Openings' },
  {
    name: 'topOpenings',
    type: 'text',
    initial: '0,-12,10,6;18,8,6,10',
    caption:
      'Top openings "x,y,width,height;..." (rectangular). x,y relative to PCB center'
  },

  { name: 'gFasteners', type: 'group', initial: 'closed', caption: 'Lid Fastening Screw Bosses / Dimensions' },
  {
    name: 'fastenerPositions',
    type: 'text',
    initial: '-33,-23;33,-23;-33,23;33,23',
    caption: 'Fastener positions "x,y;x,y;..." relative to PCB center'
  },
  { name: 'fastenerBossDiameter', type: 'float', initial: 7, caption: 'Fastener boss outer diameter' },
  { name: 'fastenerTapHoleDiameter', type: 'float', initial: 2.6, caption: 'Fastener tap-hole diameter, in box boss' },
  { name: 'fastenerTapHoleDepth', type: 'float', initial: 4, caption: 'Fastener tap-hole depth, from boss top -- clamped to stay blind' },
  { name: 'fastenerScrewClearanceDiameter', type: 'float', initial: 3.4, caption: 'Fastener shaft clearance diameter, through lid' },
  { name: 'fastenerHeadDiameter', type: 'float', initial: 6, caption: 'Fastener screw head / counterbore diameter' },
  { name: 'fastenerCountersinkDepth', type: 'float', initial: 1.8, caption: 'Counterbore depth, from lid outer surface' },

  { name: 'gPcbBosses', type: 'group', initial: 'closed', caption: 'PCB Screw Bosses' },
  { name: 'pcbBossOuterDiameter', type: 'float', initial: 6, caption: 'Boss outer diameter' },
  { name: 'pcbBossHoleDiameter', type: 'float', initial: 2.6, caption: 'Boss screw-hole diameter' },
  { name: 'pcbBossHoleDepth', type: 'float', initial: 6, caption: 'Boss hole depth, from boss top -- clamped to stay blind' },
  {
    name: 'pcbBossPositions',
    type: 'text',
    initial: '-20,-12;20,-12;-20,12;20,12',
    caption: 'Boss positions "x,y;x,y;..." relative to PCB center'
  },

  { name: 'gOutput', type: 'group', caption: 'Output' },
  { name: 'showBox', type: 'checkbox', checked: true, caption: 'Show box' },
  { name: 'showLid', type: 'checkbox', checked: true, caption: 'Show lid' },
  { name: 'showPcbPreview', type: 'checkbox', checked: true, caption: 'Show reference PCB' },
  { name: 'showPcbDimensions', type: 'checkbox', checked: true, caption: 'Show PCB length/width/hole dimensions' },
  { name: 'showOpeningMarkers', type: 'checkbox', checked: true, caption: 'Show side/top-opening positions on the PCB' },
  { name: 'explodedView', type: 'checkbox', checked: true, caption: 'Lift lid for viewing' },
  { name: 'explodeDistance', type: 'float', initial: 15, caption: 'Lid lift distance' }
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

// Builds a small flat block of 3D "vector font" text (the standard jscad
// recipe: vectorText -> a chain of hulled circles per stroke -> extrude),
// centered on the origin in X, extruded a short distance up +Z. Callers
// translate/rotate/colorize it into place. Used only for PCB-preview
// annotations -- never part of the printed box/lid geometry.
const makeLabel = (str, charHeight, extrudeHeight) => {
  const s = String(str)
  if (s.length === 0) return null
  const strokeRadius = charHeight * 0.08
  const paths = vectorText({ x: 0, y: 0, height: charHeight }, s)
  const strokes = paths
    .filter((pts) => pts.length > 0)
    .map((pts) =>
      pts.length === 1
        ? circle({ radius: strokeRadius, center: pts[0], segments: 8 })
        : hullChain(pts.map((p) => circle({ radius: strokeRadius, center: p, segments: 8 })))
    )
  if (strokes.length === 0) return null
  const flat = extrudeLinear({ height: extrudeHeight }, union(strokes))

  // vectorText lays characters out left-to-right starting at x=0; shift
  // by an approximate half-width so callers can position by the label's
  // horizontal middle instead of its start.
  const approxWidth = charHeight * 0.6 * s.length
  return translate([-approxWidth / 2, 0, 0], flat)
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
const main = (params) => {
  const {
    pcbLength, pcbWidth, pcbThickness,
    pcbClearanceX, pcbClearanceY, standoffHeight, topClearance,
    wallThickness, floorThickness, lidCeilingThickness, circleSegments,
    splitHeight,
    pcbBossOuterDiameter, pcbBossHoleDiameter, pcbBossHoleDepth, pcbBossPositions,
    fastenerPositions, fastenerBossDiameter,
    fastenerTapHoleDiameter, fastenerTapHoleDepth,
    fastenerScrewClearanceDiameter, fastenerHeadDiameter, fastenerCountersinkDepth,
    sideOpenings,
    topOpenings,
    showPcbPreview, showPcbDimensions, showOpeningMarkers,
    showBox, showLid, explodedView, explodeDistance
  } = params

  // derived footprint dimensions
  const innerLength = pcbLength + 2 * pcbClearanceX   // PCB compartment, X
  const innerWidth = pcbWidth + 2 * pcbClearanceY      // PCB compartment, Y
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

  // PCB screw bosses (solid posts + coaxial screw holes)
  const bossRadius = pcbBossOuterDiameter / 2
  const holeRadius = pcbBossHoleDiameter / 2
  const bossTopZ = floorThickness + standoffHeight

  parseRows(pcbBossPositions).forEach((row) => {
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
    const holeDepth = Math.min(pcbBossHoleDepth, maxHoleDepth) + EPS
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

    // box side: solid boss standing on the floor, up to the cavity ceiling
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

    // lid side: through clearance shaft ...
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

  parseRows(sideOpenings).forEach((row) => {
    if (!isValidRow(row) || row.length < 5) return
    const [side, pos, width, height, zOff] = row
    const zLow = zOff
    const zHigh = zOff + height

    // portion below the parting line: cut into the box
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

    // portion above the parting line: cut into the lid
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

  parseRows(topOpenings).forEach((row) => {
    if (!isValidRow(row) || row.length < 4) return
    const [x, y, width, height] = row
    const cutter = translate([x, y, capCutZ], cuboid({ size: [width, height, capCutHeight] }))
    lid = subtract(lid, cutter)
  })

  // ==========================================================================
  // PCB PREVIEW -- translucent reference PCB + dimension/opening annotations.
  // Visualization only: sits in the assembled position but is never part of
  // the printed box/lid geometry, and (unlike the lid) is never shifted by
  // explodedView since it stays seated on the box's standoffs either way.
  // ==========================================================================
  const previewParts = []
  if (showPcbPreview) {
    const labelH = 1.4       // vector-text character height
    const labelX = 0.6       // extrusion height of label/annotation geometry
    const pcbTopZ = pcbZTop + EPS
    const bossHoleRadius = pcbBossHoleDiameter / 2

    // PCB slab, with mounting holes cut at the boss positions
    let pcbSlab = translate(
      [0, 0, pcbZBottom + pcbThickness / 2],
      cuboid({ size: [pcbLength, pcbWidth, pcbThickness] })
    )
    parseRows(pcbBossPositions).forEach((row) => {
      if (!isValidRow(row) || row.length < 2) return
      const [x, y] = row
      const hole = translate(
        [x, y, pcbZBottom + pcbThickness / 2],
        cylinder({ radius: bossHoleRadius, height: pcbThickness + EPS * 2, segments: circleSegments })
      )
      pcbSlab = subtract(pcbSlab, hole)
    })
    previewParts.push(colorize([0.15, 0.55, 0.25, 0.55], pcbSlab))

    if (showPcbDimensions) {
      const dimColor = [0.9, 0.85, 0.05]
      const dimOffset = 10      // distance of dimension line from PCB edge
      const witnessLen = dimOffset - 1

      // overall length (X), witness lines + dimension line + label,
      // laid out below the PCB's -Y edge
      const lenDimY = -pcbWidth / 2 - dimOffset
      const lengthAnnotation = union([
        translate([0, lenDimY, pcbTopZ], cuboid({ size: [pcbLength, 0.3, labelX] })),
        translate([-pcbLength / 2, lenDimY + witnessLen / 2, pcbTopZ], cuboid({ size: [0.3, witnessLen, labelX] })),
        translate([pcbLength / 2, lenDimY + witnessLen / 2, pcbTopZ], cuboid({ size: [0.3, witnessLen, labelX] }))
      ])
      previewParts.push(colorize(dimColor, lengthAnnotation))
      const lengthLabel = makeLabel(`${pcbLength}mm`, labelH, labelX)
      if (lengthLabel) previewParts.push(colorize(dimColor, translate([0, lenDimY - 3, pcbTopZ], lengthLabel)))

      // overall width (Y), laid out left of the PCB's -X edge
      const widDimX = -pcbLength / 2 - dimOffset
      const widthAnnotation = union([
        translate([widDimX, 0, pcbTopZ], cuboid({ size: [0.3, pcbWidth, labelX] })),
        translate([widDimX + witnessLen / 2, -pcbWidth / 2, pcbTopZ], cuboid({ size: [witnessLen, 0.3, labelX] })),
        translate([widDimX + witnessLen / 2, pcbWidth / 2, pcbTopZ], cuboid({ size: [witnessLen, 0.3, labelX] }))
      ])
      previewParts.push(colorize(dimColor, widthAnnotation))
      const widthLabel = makeLabel(`${pcbWidth}mm`, labelH, labelX)
      if (widthLabel) {
        previewParts.push(colorize(dimColor, translate([widDimX - 3, 0, pcbTopZ], rotateZ(Math.PI / 2, widthLabel))))
      }

      // mounting-hole position labels
      parseRows(pcbBossPositions).forEach((row) => {
        if (!isValidRow(row) || row.length < 2) return
        const [x, y] = row
        const holeLabel = makeLabel(`${x},${y}`, labelH * 0.8, labelX)
        if (holeLabel) {
          previewParts.push(colorize(dimColor, translate([x, y - bossHoleRadius - 2.5, pcbTopZ], holeLabel)))
        }
      })
    }

    if (showOpeningMarkers) {
      // lid top openings: their x,y are already PCB-centered
      // coordinates, so draw the cutout outline directly on the PCB
      const lidOpeningColor = [0.95, 0.45, 0.05]
      parseRows(topOpenings).forEach((row) => {
        if (!isValidRow(row) || row.length < 4) return
        const [x, y, width, height] = row
        const frameThickness = 0.6
        const outerRect = cuboid({ size: [width, height, labelX] })
        const innerRect = cuboid({
          size: [Math.max(width - frameThickness * 2, 0.1), Math.max(height - frameThickness * 2, 0.1), labelX * 2]
        })
        previewParts.push(colorize([...lidOpeningColor, 0.9], translate([x, y, pcbTopZ], subtract(outerRect, innerRect))))

        const posLabel = makeLabel(`${x},${y} ${width}x${height}`, labelH * 0.8, labelX)
        if (posLabel) {
          previewParts.push(colorize(lidOpeningColor, translate([x, y + height / 2 + 2.5, pcbTopZ], posLabel)))
        }
      })

      // side ports: a marker spanning the opening's width, drawn at
      // the PCB edge it faces, labeled with its wall position and Z range
      const sidePortColor = [0.85, 0.1, 0.6]
      const markerThickness = 1.2
      parseRows(sideOpenings).forEach((row) => {
        if (!isValidRow(row) || row.length < 5) return
        const [side, pos, width, , zOff] = row
        const height = row[3]
        let marker = null
        let labelPos = null
        let label = makeLabel(`${pos} @ z${zOff}-${zOff + height} ${width}x${height}`, labelH * 0.7, labelX)

        if (side === 0) { // front, -Y
          marker = translate([pos, -pcbWidth / 2 + markerThickness / 2, pcbTopZ], cuboid({ size: [width, markerThickness, labelX] }))
          labelPos = [pos, -pcbWidth / 2 + markerThickness + 2.5, pcbTopZ]
        } else if (side === 2) { // back, +Y
          marker = translate([pos, pcbWidth / 2 - markerThickness / 2, pcbTopZ], cuboid({ size: [width, markerThickness, labelX] }))
          labelPos = [pos, pcbWidth / 2 - markerThickness - 2.5, pcbTopZ]
        } else if (side === 1) { // right, +X
          marker = translate([pcbLength / 2 - markerThickness / 2, pos, pcbTopZ], cuboid({ size: [markerThickness, width, labelX] }))
          labelPos = [pcbLength / 2 - markerThickness - 2.5, pos, pcbTopZ]
          label = label && rotateZ(Math.PI / 2, label)
        } else if (side === 3) { // left, -X
          marker = translate([-pcbLength / 2 + markerThickness / 2, pos, pcbTopZ], cuboid({ size: [markerThickness, width, labelX] }))
          labelPos = [-pcbLength / 2 + markerThickness + 2.5, pos, pcbTopZ]
          label = label && rotateZ(Math.PI / 2, label)
        }

        if (marker) previewParts.push(colorize([...sidePortColor, 0.9], marker))
        if (label && labelPos) previewParts.push(colorize(sidePortColor, translate(labelPos, label)))
      })
    }
  }

  if (explodedView) {
    lid = translate([0, 0, explodeDistance], lid)
  }

  // ---- assemble output ----
  const parts = []
  if (showBox) parts.push(colorize([0.55, 0.55, 0.6], box))
  if (showLid) parts.push(colorize([0.25, 0.55, 0.85, 0.85], lid))
  parts.push(...previewParts)

  return parts
}

module.exports = { getParameterDefinitions, main }
