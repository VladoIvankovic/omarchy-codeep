import QtQuick
import QtQuick.Shapes

// Codeep's logo in one colour: four corner brackets and four chevrons on the
// 960 x 960 grid of Codeep.svg. Drawn as a Shape so the colour is whatever the
// bar's foreground is at the moment — an Image of an SVG cannot be recoloured.
// The same path data is in assets/logo-mono.svg (test/package.test.mjs keeps
// the two together).
//
// `lit` is the "working" cue: -1 paints the four chevrons the same; 0..3 paints
// that chevron at full strength and the others dimmed, so a timer stepping it
// turns the mark into a small clockwise chase. The caller steps it a few times
// a second, not every frame.
Item {
  id: root

  property color color: "white"
  property int lit: -1
  property real dimmed: 0.35

  implicitWidth: 16
  implicitHeight: 16

  function tone(index) {
    var a = root.lit < 0 || root.lit === index ? 1 : root.dimmed
    return Qt.rgba(root.color.r, root.color.g, root.color.b, root.color.a * a)
  }

  Shape {
    width: 960
    height: 960
    scale: root.width / 960
    transformOrigin: Item.TopLeft
    // Curve-based fill is anti-aliased without MSAA; the mark is mostly diagonals.
    preferredRendererType: Shape.CurveRenderer

    ShapePath {
      fillColor: root.color
      strokeColor: "transparent"
      strokeWidth: 0
      PathSvg { path: "M0 0H312V104H104V312H0Z M960 0V312H856V104H648V0Z M960 960H648V856H856V648H960Z M0 960V648H104V856H312V960Z" }
    }
    ShapePath {
      fillColor: root.tone(0)
      strokeColor: "transparent"
      strokeWidth: 0
      PathSvg { path: "M480 0L645 165L571.461 238.539L480 147.078L388.539 238.539L315 165Z" }
    }
    ShapePath {
      fillColor: root.tone(1)
      strokeColor: "transparent"
      strokeWidth: 0
      PathSvg { path: "M960 480L795 645L721.461 571.461L812.922 480L721.461 388.539L795 315Z" }
    }
    ShapePath {
      fillColor: root.tone(2)
      strokeColor: "transparent"
      strokeWidth: 0
      PathSvg { path: "M480 960L315 795L388.539 721.461L480 812.922L571.461 721.461L645 795Z" }
    }
    ShapePath {
      fillColor: root.tone(3)
      strokeColor: "transparent"
      strokeWidth: 0
      PathSvg { path: "M0 480L165 315L238.539 388.539L147.078 480L238.539 571.461L165 645Z" }
    }
  }
}
