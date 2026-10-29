package sfu

// vp8Descriptor is the part of a VP8 RTP payload descriptor (RFC 7741 §4.2) the
// forwarder needs: whether a packet starts a keyframe, and where the picture
// numbering fields sit so they can be renumbered in place.
type vp8Descriptor struct {
	valid bool
	// keyframe is set on the first packet of a keyframe only.
	keyframe bool

	hasPictureID bool
	// pictureIDWide is the 15-bit form; otherwise the field is 7 bits.
	pictureIDWide   bool
	pictureID       uint16
	pictureIDOffset int

	hasTL0PicIdx    bool
	tl0PicIdx       uint8
	tl0PicIdxOffset int
}

// parseVP8 reads the payload descriptor at the start of an RTP payload.
func parseVP8(payload []byte) vp8Descriptor {
	var d vp8Descriptor
	if len(payload) < 1 {
		return d
	}
	b0 := payload[0]
	extended := b0&0x80 != 0
	start := b0&0x10 != 0
	partition := b0 & 0x07

	i := 1
	if extended {
		if len(payload) <= i {
			return d
		}
		b1 := payload[i]
		i++
		hasPictureID := b1&0x80 != 0
		hasTL0 := b1&0x40 != 0
		hasTID := b1&0x20 != 0
		hasKeyIdx := b1&0x10 != 0

		if hasPictureID {
			if len(payload) <= i {
				return d
			}
			d.hasPictureID = true
			d.pictureIDOffset = i
			if payload[i]&0x80 != 0 {
				if len(payload) <= i+1 {
					return d
				}
				d.pictureIDWide = true
				d.pictureID = uint16(payload[i]&0x7f)<<8 | uint16(payload[i+1])
				i += 2
			} else {
				d.pictureID = uint16(payload[i] & 0x7f)
				i++
			}
		}
		if hasTL0 {
			if len(payload) <= i {
				return d
			}
			d.hasTL0PicIdx = true
			d.tl0PicIdxOffset = i
			d.tl0PicIdx = payload[i]
			i++
		}
		if hasTID || hasKeyIdx {
			i++
		}
	}
	if len(payload) <= i {
		return d
	}
	d.valid = true
	// The keyframe bit lives in the VP8 payload header, which only follows the
	// descriptor on the first packet of the first partition. P=0 means key frame.
	d.keyframe = start && partition == 0 && payload[i]&0x01 == 0
	return d
}

// pictureIDMask is the modulus picture IDs wrap at for this descriptor's field width.
func (d *vp8Descriptor) pictureIDMask() uint16 {
	if d.pictureIDWide {
		return 0x7fff
	}
	return 0x7f
}

// rewrite stores new picture numbering into payload, which must be the buffer d
// was parsed from (or a copy of it).
func (d *vp8Descriptor) rewrite(payload []byte, pictureID uint16, tl0PicIdx uint8) {
	if d.hasPictureID {
		if d.pictureIDWide {
			payload[d.pictureIDOffset] = 0x80 | byte(pictureID>>8)&0x7f
			payload[d.pictureIDOffset+1] = byte(pictureID)
		} else {
			payload[d.pictureIDOffset] = byte(pictureID) & 0x7f
		}
	}
	if d.hasTL0PicIdx {
		payload[d.tl0PicIdxOffset] = tl0PicIdx
	}
}
