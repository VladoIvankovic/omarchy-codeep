import QtQuick
import QtQuick.Shapes

// Codeep's mascot, drawn from the artwork in Codeep-web's Mascot.tsx (viewBox
// 105 149 1301 1214), in one colour. The legs stay planted; `raised` lifts
// everything above them by one sprite pixel (30 units), which is the whole of
// its bob. The caller flips it from a slow timer: a few steps a second, like
// the website's hard-stepped animation, not a tween.
//
// Limbs reach into the body, as on the website, so the edges where separate
// shapes meet leave no hairline. The same path data is in assets/mascot.svg
// (test/package.test.mjs keeps the two together).
Item {
  id: root

  property color color: "white"
  property bool raised: false

  implicitWidth: 40
  implicitHeight: Math.round(implicitWidth * 1214 / 1301)

  Item {
    width: 1301
    height: 1214
    scale: root.width / 1301
    transformOrigin: Item.TopLeft

    // Legs, planted.
    Shape {
      x: -105
      y: -149
      width: 1406
      height: 1363
      preferredRendererType: Shape.CurveRenderer

      ShapePath {
        fillColor: root.color
        strokeColor: "transparent"
        strokeWidth: 0
        PathSvg { path: "M335 1073H565V1363H335Z M946 1073H1176V1363H946Z" }
      }
    }

    // Everything above the legs: hands, joint fillers, the body with its two
    // eye sockets cut out (even-odd), and the pupils.
    Shape {
      x: -105
      y: -149 - (root.raised ? 30 : 0)
      width: 1406
      height: 1363
      preferredRendererType: Shape.CurveRenderer

      ShapePath {
        fillColor: root.color
        strokeColor: "transparent"
        strokeWidth: 0
        PathSvg { path: "M105 597H355V827H105Z M1156 597H1406V827H1156Z M226 577H356V617H226Z M1156 577H1291V617H1156Z" }
      }
      ShapePath {
        fillColor: root.color
        strokeColor: "transparent"
        strokeWidth: 0
        fillRule: ShapePath.OddEvenFill
        PathSvg { path: "M1176 1133H335V597H226V149H674V292H843V149H1291V597H1176ZM1215 225H918V522H1215ZM598 225H301V522H598Z" }
      }
      ShapePath {
        fillColor: root.color
        strokeColor: "transparent"
        strokeWidth: 0
        PathSvg { path: "M392 316H507V431H392Z M1009 316H1124V431H1009Z" }
      }
    }
  }
}
