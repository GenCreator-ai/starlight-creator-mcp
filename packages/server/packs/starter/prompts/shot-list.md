---
name: shot-list
description: Turn a scene description into a numbered shot list with camera, lens and light notes.
arguments:
  - name: scene
    description: One paragraph describing the scene, mood and subjects.
    required: true
  - name: shots
    description: How many shots to plan (default 6).
---
Plan {{shots}} shots for this scene. For each shot give: number, framing (wide/medium/close), camera movement, lens in mm, the single motivated light source, and a one-line prompt ready for an image model.

Scene:
{{scene}}
