# Clayframe

Sculpt, rig and animate 3D characters in the browser, then puppet them live. It's a home-screen web app with no build step, and it works offline once loaded.

## Modes
- **Sculpt**: Clay, Draw, Inflate, Smooth, Flatten, Pinch, Crease, Move, Mask and Paint. Size and strength are on the left sliders, ⇋ X mirrors, and − Sub inverts. Subdivide adds detail. One finger sculpts and two fingers orbit, pan and zoom.
- **Objects**: add primitives or import an OBJ. Drag an object to move it, or use the arrows (move along an axis), rings (turn) and outer circle (size). Look sets colour and material (matcaps), Shapes holds sculpted shape keys, and Parent attaches an object to another object or to one of its bones.
- **Rig**: tap inside a limb to drop joints; each tap after the first adds a bone. With ⇋ X on, arms and legs are mirrored. Drag joints to adjust them. Bind (or leaving Rig) works out the skin weights automatically.
- **Pose**: drag a joint to pose it. With IK on, the bones above it bend too (Chain sets how many). The rings turn the selected bone.
- **Stage**: puppet a character with a game controller (Gamepad API) or the on-screen sticks, triggers and A button. Record plays the timeline and writes what you did as keyframes, so you can layer takes. ⚙ Controls changes what each input does.

## New in this version
- **Face puppeteering** (Stage → 🙂 Face): your front camera drives the character. Head turn, nod and tilt move the head bone, and mouth open, smile, blink, brows, pucker, cheek puff and wide eyes drive shapes. Name shapes after expressions (Smile, Blink, Jaw open) and they connect themselves; anything else can be mapped in ⚙ Controls. Tap Centre while looking straight ahead. It uses Google's MediaPipe face tracker, which runs on the device so no video leaves it. The first time it needs the internet (about 4 MB, then it's cached), and it asks for camera permission.
- **Dynamic detail** (⚙ Brush): strokes add triangles where they stretch the surface. Detail follows the brush size.
- **Remesh**: rebuilds the surface with even triangles and merges overlapping parts. Shapes, paint and the rig carry over.
- **Snake hook** brush. Brushes now only reach surface joined to where you touch. Mirroring works on X, Y or Z: tap ⇋ to cycle.
- **Faster strokes** on detailed meshes. Stylus pressure can control brush size and strength. **Wireframe** (▦).
- **Weight painting** (Rig → Weights): pick a bone, then paint how much it moves the skin.
- **Mirror →** copies a pose to the other side; **Flip pose** swaps sides.
- **Poses** saves poses you can reuse. **Cycles** makes walk and idle loops. Any object can repeat its animation.
- **Curves** (〰) edits keyframe values on a graph. **Onion skin** (◎) shows the keyframe poses before and after.
- **Stage**: saved poses can go on buttons (they blend in while held). Legs swing while walking. All face buttons, bumpers and the D-pad can be mapped. Each recording is kept as a **take**.
- **Render view** (☀): lights, soft shadows and a floor. Video export can use it.
- **GLB export**: the whole scene with bones, skin weights, shapes, animation and the shot camera.

## Animation
- ◇ keyframes the selection at the playhead. ● auto-key keyframes every change.
- Tap a ◆ on the timeline to jump to it, tap it again to set its easing, or drag it to retime.
- 🎥◆ keyframes the camera view, and 🎥 plays through the camera keys.
- Export records a video (through the camera keys if there are any) or saves the selected object as an OBJ as posed.

## Files
- `math.js`: vectors, quaternions, matrices, easing.
- `mesh.js`: meshes, primitives, subdivision, ray casting, OBJ.
- `sculpt.js`: brushes.
- `scene.js`: keyframes, bones, skinning weights, IK, shape keys, camera track.
- `render.js`: WebGL2 renderer with matcaps and GPU skinning.
- `app.js`: the editor.
- Projects are stored in IndexedDB on the device. ⋯ → Save a backup file moves a project between devices.
- When you change files, bump `VERSION` in `sw.js` so installed copies update.
