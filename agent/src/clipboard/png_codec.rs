//! PNG is the wire format for images; desktops that hand out pixels need it encoded and decoded.

pub fn encode(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    if rgba.len() != width * height * 4 {
        return Err(format!(
            "{width}x{height} image with {} bytes of pixels",
            rgba.len()
        ));
    }
    let w = u32::try_from(width).map_err(|e| e.to_string())?;
    let h = u32::try_from(height).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_compression(png::Compression::Fast);
    let mut writer = enc.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(out)
}

/// `(width, height, rgba)`, whatever the PNG's own color type and depth.
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub fn decode(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
    dec.set_transformations(
        png::Transformations::EXPAND | png::Transformations::STRIP_16 | png::Transformations::ALPHA,
    );
    let mut reader = dec.read_info().map_err(|e| e.to_string())?;
    let size = reader.output_buffer_size().ok_or("image too large")?;
    let mut buf = vec![0; size];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(info.buffer_size());
    let (w, h) = (info.width as usize, info.height as usize);
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::GrayscaleAlpha => buf
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|[g, a]| [*g, *g, *g, *a])
            .collect(),
        other => return Err(format!("unexpected PNG color type {other:?}")),
    };
    Ok((w, h, rgba))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_pixels() {
        let rgba: Vec<u8> = (0..2 * 3 * 4).map(|i| i as u8).collect();
        let png = encode(2, 3, &rgba).unwrap();
        assert_eq!(&png[1..4], b"PNG");
        assert_eq!(decode(&png).unwrap(), (2, 3, rgba));
        assert!(encode(2, 2, &[0; 3]).is_err());
    }
}
