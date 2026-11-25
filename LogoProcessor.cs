using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class LogoProcessor {
  public static void Run(string input, string fullOutput, string iconOutput) {
    using (var image = new Bitmap(input)) {
      var rect = new Rectangle(0, 0, image.Width, image.Height);
      var data = image.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
      int stride = Math.Abs(data.Stride), count = stride * image.Height;
      var bytes = new byte[count]; Marshal.Copy(data.Scan0, bytes, 0, count);
      var seen = new byte[image.Width * image.Height];
      var queue = new int[image.Width * image.Height];
      int head = 0, tail = 0;
      Action<int,int> enqueue = (x,y) => { int i=y*image.Width+x; if(x>=0&&x<image.Width&&y>=0&&y<image.Height&&!Convert.ToBoolean(seen[i])&&IsBackground(bytes,(y*stride+x*4))) { seen[i]=1; queue[tail++]=i; } };
      for (int x=0;x<image.Width;x++) { enqueue(x,0); enqueue(x,image.Height-1); }
      for (int y=0;y<image.Height;y++) { enqueue(0,y); enqueue(image.Width-1,y); }
      while(head<tail) {
        int i=queue[head++], x=i%image.Width, y=i/image.Width, o=y*stride+x*4;
        bytes[o+3]=0;
        if(x>0) enqueue(x-1,y); if(x+1<image.Width) enqueue(x+1,y); if(y>0) enqueue(x,y-1); if(y+1<image.Height) enqueue(x,y+1);
      }
      Marshal.Copy(bytes,0,data.Scan0,count); image.UnlockBits(data);
      int minX=image.Width,minY=image.Height,maxX=-1,maxY=-1;
      for(int y=0;y<image.Height;y++) for(int x=0;x<image.Width;x++) if(image.GetPixel(x,y).A>0){if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}
      var fullRect=new Rectangle(minX,minY,maxX-minX+1,maxY-minY+1);
      using(var full=new Bitmap(fullRect.Width,fullRect.Height,PixelFormat.Format32bppArgb)) { using(var g=Graphics.FromImage(full)){g.DrawImage(image,new Rectangle(0,0,fullRect.Width,fullRect.Height),fullRect,GraphicsUnit.Pixel);} full.Save(fullOutput,ImageFormat.Png); }
      using(var icon=new Bitmap((int)(fullRect.Width*.9),(int)(fullRect.Height*.66),PixelFormat.Format32bppArgb)) { using(var g=Graphics.FromImage(icon)){g.DrawImage(image,new Rectangle(0,0,icon.Width,icon.Height),new Rectangle(fullRect.X+(int)(fullRect.Width*.05),fullRect.Y,(int)(fullRect.Width*.9),(int)(fullRect.Height*.66)),GraphicsUnit.Pixel);} icon.Save(iconOutput,ImageFormat.Png); }
    }
  }
  static bool IsBackground(byte[] bytes,int o){ return bytes[o+2]>=238 && bytes[o+1]>=238 && bytes[o]>=238; }
}
