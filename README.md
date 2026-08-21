# PCB Box Generator

A parametric [OpenJSCAD](https://openjscad.org/) script that generates a 3D-printable, two-piece PCB enclosure (box + lid) from a set of dimensions and part positions.

Feed it a PCB footprint, mounting-hole positions, and any side/top openings you need (connectors, switches, cable pass-throughs), and it produces a box and lid that:

- fit the PCB with configurable clearance and standoff height
- mount the PCB on screw bosses
- split box and lid at a configurable parting line, so side openings are automatically divided to avoid unsupported overhangs when printed
- fasten together with separate screw bosses
- include an optional translucent PCB preview, with dimensions and opening positions annotated, to sanity-check the layout before printing

## Usage

Open [`generator.js`](generator.js) in the [OpenJSCAD online playground](https://openjscad.xyz/) or the [CLI / desktop app](https://github.com/jscad/OpenJSCAD.org)

Adjust the parameters in the UI (or the `getParameterDefinitions` defaults in the script) to match your PCB and enclosure needs, then export the box and lid as separate STLs for printing.

Built against the [`@jscad/modeling`](https://github.com/jscad/OpenJSCAD.org/tree/master/packages/modeling) API (OpenJSCAD V2).
