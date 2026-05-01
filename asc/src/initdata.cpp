//
// initdata.cpp
//
// This file inits the voxel data with different mathematical functions,
// medical data and heightfield data.
//
// Tien-Tsin Wong 1996
//

#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include "datatype.h"
#include "misc.h"
#include "common.h"
#include "vortex.h"
#include "initdata.h"
#ifdef WIN32
#include "pcvalues.h"
#include <io.h>
#else
#include <unistd.h>
#include <sys/uio.h>
#endif

////////////////////////// Function Prototypes ///////////////////////
int bfOpen (int *handle, DCHAR *name);
int bfRead (int handle, void *buffer, UNS32 nbytes);
int bfWrite (int handle, void *buffer, UNS32 nbytes);
int bfSeek(int handle, UNS32 offset);
int bfClose (int handle);


// fill a voxel metaball, each elements filled with the
// distance from curr to centre. ie far elements have higher
// value and vice versa.
// Actually 2 spheres or metaball
void InitDataMetaball(VOXELDT *data, int width, int depth, int height)
{
  register int i, j, k;
  double cx, cy, cz, cx2, tmp;
  int mult1=width*depth, off;
  double scale, distsqr, maxdist;
  double maxvalue=-1000, minvalue=1000, valuescale=0;
  
  scale = 255.0/M_E;
  cx = width/4.0;
  cx2 = width*3.0/4.0;
  cy = depth/2.0;
  cz = height/2.0;
  maxdist = 0.2*sqrt(cx*cx*4 + cy*cy + cz*cz);
  for (k=0 ; k<height ; k++)
    for (j=0 ; j<depth ; j++)
      for (i=0 ; i<width ; i++)
      {
        tmp = (j-cy)*(j-cy) + (k-cz)*(k-cz);
	distsqr = exp(-sqrt((i-cx)*(i-cx)+tmp)/maxdist) +
		  exp(-sqrt((i-cx2)*(i-cx2)+tmp)/maxdist);
	distsqr *= scale;
	if (distsqr>255.0)
          distsqr = 255.0;
	if (distsqr>maxvalue)
          maxvalue = (VOXELDT)distsqr;
        if (distsqr<minvalue)
          minvalue = (VOXELDT)distsqr;
        data[k*mult1 + j*width + i] = (VOXELDT)distsqr;
      }
  valuescale = 255/(maxvalue - minvalue);
  for (k=0 ; k<height ; k++)
    for (j=0 ; j<depth ; j++)
      for (i=0 ; i<width ; i++)
      {
        off = k*mult1 + j*width + i;
        data[off] = (VOXELDT)((data[off]-minvalue)*valuescale);
      }
}


void InitKnotSurface(VOXELDT *data, int col, int row, int slc, int sqr=0)
{
  int hrow, hcol, hslc;
  double f, m, p, q, rr, ss, k1, k2, sixth, g, F, x, y, z;
  VOXELDT *ptr;

//  slc = DATAHEIGHT;
//  row = DATAWIDTH;
//  col = DATADEPTH;
  if (sqr==0)
    sqr = col/2;
  fprintf(stderr, "Creating a cube size %d d\n", sqr);
  hrow = row>>1;
  hcol = col>>1;
  hslc = slc>>1;

  for (register int s=0, zz=-hslc ; s<slc ; s++, zz++)
  {
    ptr = &(data[s*row*col]);
    for (register int r=0, yy=-hrow ; r<row; r++, yy++)
      for (register int c=0, xx=-hcol; c<col; c++, xx++)
      {
        z = (double)zz / hslc * 5.0;
        y = (double)yy / hrow * 5.0;
        x = (double)xx / hcol * 5.0;

	//printf ("x = %12f, y = %12f z = %12f \n", x, y, z);
        m = 1 + x*x + y*y + z*z;
	p = 2.0 * x / m;
	q = 2.0 * y / m;
	rr = 2.0 * z / m;
        ss = (m - 2) / m ;

        k1 = p * p - q * q + rr * rr * rr - 3 * rr * ss * ss;
        k2 = 2 * p * q - 3 * rr * rr * ss + ss * ss * ss;

        f = k1 * k1 + k2 * k2;

        sixth = 1.0/6.0;
	g = M_PI * pow(f, sixth);

        F = sin (g);    // F in [-1, 1]

        *ptr++ = (VOXELDT)((F +1)/2.0 * 255.0);  // scale to 0 255
      }
  }
}



void InitDataHeightField(VOXELDT *&data, long &width, long &depth, long &height, DCHAR *filename)
{
  int off, z, imagesize, address;
  FILE *fptr;
  UCHAR *hfbuf;
  DCHAR magicnumber[1000];

  if ((fptr=fopen(filename,"rb"))==NULL)
    ERREXIT("[InitDataHeightField]: Cannot open heightfield file\n");
  fscanf(fptr, "%s", magicnumber);
  if (strncmp(magicnumber, "P5", 2)!=0)  // not pgm raw data format
    ERREXIT("[InitDataHeightField]: File is not pgm format\n");
  fscanf(fptr, "%d %d %d", &width, &depth, &height);
  fprintf(stderr, "HeightField size: %d x %d\n", width, depth);

  if ((data=(VOXELDT*)malloc(sizeof(VOXELDT)*width*depth*height))==NULL
  ||  (hfbuf=(UCHAR*)malloc(sizeof(UCHAR)*width*depth))==NULL)
    ERREXIT("[InitDataHeightField]: Not enough memory for data and hfbuf\n");
  memset(data, 0, width*depth*height);

  fgetc(fptr); // skip one more whitespace
  if (cp_fread(hfbuf, 1, width*depth, fptr)<width*depth)
    ERREXIT("[InitDataHeightField]: pgm file corrupted\n");

  imagesize = depth*width;
  for (off=0 ; off<imagesize ; off++)  // for each pixel (x,y) in the heightfield
    for (z=0, address=off ; z<hfbuf[off] && z<height ; z++, address+=imagesize)  // fill z(=pixel value) vertical entries in the voxel with 100
      data[address] = 100;  // the voxel is filled with value either 0 or 100

  free(hfbuf);
  fclose(fptr);
}



int readMiraFile(volume *v, DCHAR *filename, short textureblock, float actualzgap)
{
  fileheader imap;
  int     i,l,j,k;
  int     f;
  int     retval = 0;
  UCHAR   *byteptr;
  UNS16   *ip,voxel,maxvoxel;
  int     nbytes;
  float   voxelscale;

  retval = bfOpen(&f, filename);
  if (retval == 0)
  {
    retval = bfRead(f,(void *)&imap, sizeof(fileheader));
#ifdef WIN32
    // For those data members in fileheader with size larger than 1 byte, 
    // byte order should be swapped.  (Kevin, 28-7-2001)
    SingleSwapByte((unsigned char *)(&(imap.version)), sizeof(imap.version));
    SingleSwapByte((unsigned char *)(&(imap.xres)), sizeof(imap.xres));
    SingleSwapByte((unsigned char *)(&(imap.yres)), sizeof(imap.yres));
    SingleSwapByte((unsigned char *)(&(imap.zres)), sizeof(imap.zres));
    SingleSwapByte((unsigned char *)(&(imap.flags)), sizeof(imap.flags));
    SingleSwapByte((unsigned char *)(&(imap.map_offset)), sizeof(imap.map_offset));
    SingleSwapByte((unsigned char *)(&(imap.voxel_offset)), sizeof(imap.voxel_offset));
#endif 

    if ((strncmp(imap.fileid, "VOXEL",5) != 0)
    ||  (imap.control_z != 0x1a))
    {
      fprintf(stderr, "Missing header id: VOXEL\n");
      retval = -1;
      bfClose(f);
    }
    else
    {
      if ((v->flags = imap.flags) & 0x1)
      {
	fprintf(stderr, "Can not handle compressed files\n");
	retval = -1;
      }
      else // Uncompressed voxel data
      {
	v->xsize = imap.xres;
	v->ysize = imap.yres;
	v->nslices = (int)((textureblock-1)*ceil((imap.zres-1)/(float)(textureblock-1))+1); // change fceil() -> ceil()
	v->datazres = imap.zres;
	v->nvolumes = 1;
	v->status |= BUNDLE;
	v->flags = imap.flags;
	if ((v->xmap = new (aCoord [imap.xres]))==NULL
	||  (v->ymap = new (aCoord [imap.yres]))==NULL
	||  (v->zmap = new (aCoord [imap.zres]))==NULL)
	  ERREXIT("[readMiraFile]: no memory for xmap, ymap and zmap\n");

        if ((bfSeek(f, imap.map_offset) == 0)
	&& (bfRead(f, (void *) v->xmap,imap.xres * sizeof(aCoord)) == 0)
        && (bfRead(f, (void *) v->ymap,imap.yres * sizeof(aCoord)) == 0)
        && (bfRead(f, (void *) v->zmap,imap.zres * sizeof(aCoord)) == 0)
        && (bfSeek(f,imap.voxel_offset) == 0))
        { //  voxel data is not compressed
#ifdef WIN32
          // Size of each element of v->xmap, ymap and zmap is 4 bytes, thus, 
          // byte order should be swapped.  (Kevin, 28-7-2001)
          SwapByte((unsigned char *)v->xmap, sizeof(aCoord), imap.xres);
          SwapByte((unsigned char *)v->ymap, sizeof(aCoord), imap.yres);
          SwapByte((unsigned char *)v->zmap, sizeof(aCoord), imap.zres);
#endif
          if (strstr(filename,".12") != NULL)
            v->format = TWOBYTE;
          else
            v->format = ONEBYTE;

          nbytes = imap.xres * imap.yres * sizeof(aByte) * v->format;
          if ((v->data=(UNS16*)malloc(sizeof(UNS16)*nbytes*v->nslices))==NULL)
            ERREXIT("[readMiraFile]: No memory for v->data\n");

 fprintf (stderr, "nbytes: %d   nslices: %d   format %d\n", nbytes, v->nslices, v->format);
	  for  (i = 0; (retval ==0) && (i < imap.zres); i++)
	    retval = bfRead(f, ((DCHAR *)v->data+i*(int)nbytes), nbytes);

	  ip = v->data;
	  byteptr = (UCHAR *)ip;
	  maxvoxel = 0;
	  for (l = 0; l < v->datazres  ; l++)
	    for (j = 0; j < v->ysize ; j++)
	      for (k = 0; k < v->xsize ; k++, ip++)
	      {
		voxel = *ip & 0xfff;
		if (voxel > maxvoxel)
		  maxvoxel = voxel;
	      }

	  if (v->nslices > v->datazres)
	  {
	    ip = v->data + (v->datazres*v->xsize*(int)v->ysize);
	    for (l = v->datazres; l < v->nslices; l++)
	      for (j = 0; j < v->ysize ; j++)
		for (k = 0; k < v->xsize ; k++, ip++)
		  *ip = 0;
	  }

	  ip = v->data;
	  byteptr = (UCHAR *)ip;

	  if (v->format == TWOBYTE)
          {
#ifdef WIN32
            // Since it is two-byte data (short), the buffer has to be swapped.
            SwapByte((unsigned char *)v->data, 2, v->xsize*v->ysize*v->datazres);
#endif
	    voxelscale = 255/(float)maxvoxel;
	    for (l = 0; l < v->datazres ; l++)
	      for (j = 0; j < v->ysize ; j++)
		for (k = 0; k < v->xsize ; k++, ip++)
		{
		  voxel = *ip & 0xfff;
		  *byteptr = (UCHAR)(voxel*voxelscale);
		  byteptr++;
		}
	  }
          else
            voxelscale = 1;
          fprintf(stderr, "Max Voxel value %d\n", maxvoxel);
	}
        else
        {
	  retval = -1;
          fprintf(stderr, "Error while reading map ..\n");
        }
      }
    }
  }

  switch (retval)
  {
    case 0:
      v->status |= AVAILABLE;
      v->xunit = v->xmap[1]-v->xmap[0];
      v->yunit = v->ymap[1]-v->ymap[0];
      v->zunit = fabs(v->zmap[1]-v->zmap[0]);

      if (actualzgap > 0)
	v->zunit = actualzgap;
      retval = bfClose(f);
      break;

    case -1:
    default:
      fprintf(stderr, "Volume file error %s\n", filename);
      return 0;
  }
  return 1;
}


// Open an existing file for input, return 0 for success, -1 for
// error.
int bfOpen (int *handle, DCHAR *name)
{
#ifdef WIN32
  /* binary open option is required in windows platform (Kevin 28-7-2001) */
  *handle = open(name, O_RDONLY | O_BINARY);
#else
  *handle = open(name, O_RDONLY);
#endif 

  if (*handle == -1)
    return -1;
  else
    return 0;
}


// Read nbytes from a file, return 0 for success, -1 for error
int bfRead (int handle, void *buffer, UNS32 nbytes)
{
  if (read(handle, buffer, (unsigned int) nbytes) == nbytes)
    return 0;
  else
    return -1;
}


// Read nbytes from a file, return 0 for success, -1 for error
int bfWrite (int handle, void *buffer, UNS32 nbytes)
{
  if (write(handle, buffer, (unsigned int) nbytes) == nbytes)
    return 0;
  else
  {
     fprintf(stderr, "\nUnsuccesful write ");
     return -1;
  }
}


// Move file position to a specified location, offset is an integer
// specifying an offset in bytes from the start of the file
// return 0 for success, -1 for error
int bfSeek(int handle, UNS32 offset)
{
  long    retval;
  retval = lseek(handle, (long) offset, 0);
  if (retval == -1 || retval != offset)
    return -1;
  else
    return 0;
}


// Close an open file, return 0 for success, -1 for error.
int bfClose (int handle)
{
  return (close(handle));
}



// Assume data file is in 8-bit raw bytes format. x y z are organized
// as follows: x is most frequent, follow by y and lastly by z.
// The resolution of the voxel must be input.
// An allocated memory pointed by data is passed in.
void ReadRawByte(VOXELDT *data, int w, int d, int h, DCHAR *filename)
{
  FILE *fptr;
  if ((fptr=fopen(filename,"rb"))==NULL)
    ERREXIT("[ReadRawByte]:Cannot open raw byte file\n");

  if (sizeof(VOXELDT)==1)  // If 8-bit, not need to convert
  {
    if (cp_fread(data, 1, w*d*h, fptr)!=w*d*h)
      ERRMSG("[ReadRawByte]: Data file seem different from expected\n");
  }
  else   // we need to explicitly convert each data unit
  {
    UCHAR *buffer;
    long i;
    if ((buffer=(UCHAR*)malloc(w*d*h))==NULL)
      ERREXIT("[ReadRawByte]: Cannot allocate enough memory\n");
    if (cp_fread(buffer, 1, w*d*h, fptr)!=w*d*h)
      ERRMSG("[ReadRawByte]: Data file seem different from  expected\n");
    for (i=0 ; i<w*d*h ; i++)
      data[i] = (VOXELDT)buffer[i];
    free(buffer);
  }

  fclose(fptr);
}


// Assume data file is in 16-bit raw bytes format. x y z are organized
// as follows: x is most frequent, follow by y and lastly by z.
// The resolution of the voxel must be input.
// An allocated memory pointed by data is passed in.
void ReadRawByte16(VOXELDT *data, int w, int d, int h, DCHAR *filename)
{
  FILE *fptr;
  if ((fptr=fopen(filename,"rb"))==NULL)
    ERREXIT("[ReadRawByte16]:Cannot open raw byte file\n");

  if (sizeof(VOXELDT)==2)  // if 16 bits, no need to convert
  {
    if (cp_fread(data, 2, w*d*h, fptr)!=w*d*h)
      ERRMSG("[ReadRawByte16]: Data file seem different from  expected\n");
  }
  else   // we need to explicitly convert each data unit
  {
    unsigned short *buffer, maxvoxel=0;
    long i;
    float scale;

    if (sizeof(unsigned short)!=2)
      ERREXIT("[ReadRawByte16]: On this machine, short is not 2 bytes\n");
    if ((buffer=(unsigned short*)malloc(w*d*h*2))==NULL)
      ERREXIT("[ReadRawByte16]: Cannot allocate enough memory\n");
    if (cp_fread(buffer, 2, w*d*h, fptr)!=w*d*h)
      ERRMSG("[ReadRawByte16]: Data file seem different from  expected\n");

    // Find the maximum value for later scaling
    for (i=0 ; i<w*d*h ; i++)
      if (maxvoxel < buffer[i])
        maxvoxel = buffer[i];
    fprintf(stderr, "Max voxel=%i\n", maxvoxel);

    // Map [0, maxvoxel] to [0, 2^(sizeof(VOXELDT)*8)-1]
    scale = (float)((pow(2, sizeof(VOXELDT)*8) - 1) / maxvoxel);
    fprintf(stderr, "Scaling factor=%f\n", scale);
    for (i=0 ; i<w*d*h ; i++)   
      data[i] = (VOXELDT)(buffer[i]*scale + 0.5);  // scale and round
    free(buffer);
  }

  fclose(fptr);
}


// Assume data file is in PGM format. Since pgm file is only a 2D image, we
// need multiple pgm files to form a volume. We assume each pgm store a
// layer of xy image. The z dimension is along the files. The resolution of
// the volume must be input. An allocated memory pointed by data is passed
// in. Parameter "prefix" store the prefix of the image files. Assume in the
// following format:
//   <prefix><start>.pgm, <prefix><start+1).pgm, ... <prefix><start+z-1>.pgm
void ReadPGM(VOXELDT *data, int w, int d, int h, DCHAR *prefix, int start)
{
  FILE *fptr;
  int i, iw, id;
  DCHAR filename[1000], line[1000];
  UCHAR *buffer;

  // Alloc memory once for later use
  if ((buffer=(UCHAR*)malloc(w*d))==NULL)
    ERREXIT("[ReadPGM]: Cannot allocate enough memory\n");

  for (i=0 ; i<h ; i++)
  {
    sprintf(filename, "%s%02d.pgm", prefix, i+start);
    printf("Reading file %s ...\n", filename);
    if ((fptr=fopen(filename,"rb"))==NULL)
      ERREXIT("[ReadPGM]:Cannot open pgm file\n");
    // Verify the PGM
    fgets(line, 1000, fptr); // read signature
    if (line[0]!='P' || line[1]!='5')
      ERRMSG("[ReadPGM]: Not a pgm file\n");
    fgets(line, 1000, fptr); // read x y dimension
    sscanf(line, "%d %d\n", &iw, &id);
    if (iw != w || id != d)
      ERRMSG("[ReadPGM]: input pgm xy dimension not confirmed\n");
    fgets(line, 1000, fptr); // read max gray value, must be 255
    if (atoi(line) != 255)
      ERRMSG("[ReadPGM]: max gray value != 255\n");

    // read data
    if (sizeof(VOXELDT)==1)
    {
      if (cp_fread(data+(w*d*i), 1, w*d, fptr) != w*d)
        ERRMSG("[ReadPGM]: Data file seem different from  expected\n");
    }
    else   // we need to explicitly convert each data unit
    {
      long j, offset=w*d*i;
      if (cp_fread(buffer, 1, w*d, fptr) != w*d)
        ERRMSG("[ReadPGM]: Data file seem different from  expected\n");
      for (j=0 ; j<w*d ; j++)
        data[offset + j] = (VOXELDT)buffer[j];
    }
    fclose(fptr);
  }
  free(buffer);
}
 

// The following function resample the given volume of size (w x d x h)
// to a new volume size of (nw x nd x nh). It allocate memory for the
// new volume and return it to the caller. Note it does not free the old
// volume's buffer. It allows the caller to make multiple copies of the
// original volume.
void ScaleVolume(VOXELDT *data, int w, int d, int h,
		 VOXELDT *&newdata, int nw, int nd, int nh)
{
  float   wf, df, hf;   // factional part
  float   wm, dm, hm;   // multipliers
  float   resample;
  int     oldslicesize;
  int     x, y, z, i;
  int     wi, di, hi;   // integral part
  int     wi_1, di_1, hi_1;
  long    ip;
  VOXELDT *newvolume;
  float   sample[8];
  // index scheme of sample[]
  //      6       7
  //      *-------*
  //    /       / |
  //4 /     5 /   |
  // *-------*    |
  // |       |    *
  // |   2   |   / 3
  // |       | /
  // *-------*
  // 0       1

  if ((newvolume=(VOXELDT*)malloc(sizeof(VOXELDT)*nw*nd*nh))==NULL)
    ERREXIT("[ScaleVolume]: no memory for newvolume\n");

  wm = (float)(w-1)/(float)(nw-1);
  dm = (float)(d-1)/(float)(nd-1);
  hm = (float)(h-1)/(float)(nh-1);
  oldslicesize = w*d;
  // Resample the volume
  for (z=0, ip=0 ; z<nh ; z++)
  {
    hf = z * hm;        hi = (int)hf;      hf -= hi;
    hi_1 = (hi+1<h)? hi+1 : hi;
    for (y=0 ; y<nd ; y++)
    {
      df = y * dm;      di = (int)df;      df -= di;
      di_1 = (di+1<d)? di+1 : di;
      for (x=0 ; x<nw ; x++, ip++)
      {
	// trilinearly interpolate among the neighbor eight voxels
	wf = x * wm;	wi = (int)wf;  	   wf -= wi;
	wi_1 = (wi+1<w)? wi+1 : wi;

	sample[0] = data[hi*oldslicesize   + di*w   + wi];
	sample[1] = data[hi*oldslicesize   + di*w   + wi_1];
	sample[2] = data[hi*oldslicesize   + di_1*w + wi];
	sample[3] = data[hi*oldslicesize   + di_1*w + wi_1];
	sample[4] = data[hi_1*oldslicesize + di*w   + wi];
	sample[5] = data[hi_1*oldslicesize + di*w   + wi_1];
	sample[6] = data[hi_1*oldslicesize + di_1*w + wi];
	sample[7] = data[hi_1*oldslicesize + di_1*w + wi_1];

	// linear interpolate along h dimension
	for (i=0 ; i<4 ; i++)
	  sample[i] = sample[i]*(1.0-hf) + sample[i+4]*hf;
	// interpolate along d dimension
	for (i=0 ; i<2 ; i++)
	  sample[i] = sample[i]*(1.0-df) + sample[i+2]*df;
	// finally the new value
	resample = sample[0]*(1.0-wf) + sample[1]*wf;
	if (resample > 255.0)    resample = 255.0;
	else if (resample < 0.0) resample = 0.0;
	// round to nearest integer
	newvolume[ip] = (VOXELDT)(resample+0.5);
      }
    }
  }
  newdata = newvolume;   // replace newdata
}


// This routine rotate/permute the volume say <x,y,z> to <y,x,z>
// Why this is useful? Because asc will allocate huge for xy layer
// If the layer is large say 512 x 512, asc will have to swap all the time
// due to lack of memory. 
void PermuteVolume(VOXELDT *&data, int &w, int &d, int &h, 
		   double &ws, double &ds, double &hs, int neworder)
{
  VOXELDT *newdata;
  long x, y, z;
  int nw, nd, nh;
  double nws, nds, nhs;

  if ((newdata=(VOXELDT*)malloc(sizeof(VOXELDT)*w*d*h))==NULL)
    ERREXIT("[PermuteVolume]: no memory for newdata\n");
    
  switch(neworder)
  {
    case ORDER_XZY: 
      nw = w;   nd = h;   nh = d;
      nws = ws; nds = hs; nhs = ds;
      for (z=0 ; z<h ; z++)
        for (y=0 ; y<d ; y++)
          for (x=0 ; x<w ; x++)
            newdata[y*(nw*nd) + z*nw + x] = data[z*(w*d) + y*w + x];
      break;
    case ORDER_YXZ:
      nw = d;   nd = w;   nh = h;
      nws = ds; nds = ws; nhs = hs;
      for (z=0 ; z<h ; z++)
        for (y=0 ; y<d ; y++)
          for (x=0 ; x<w ; x++)
            newdata[z*(nw*nd) + x*nw + y] = data[z*(w*d) + y*w + x];
      break;
    case ORDER_YZX:
      nw = d;   nd = h;   nh = w;
      nws = ds; nds = hs; nhs = ws;
      for (z=0 ; z<h ; z++)
        for (y=0 ; y<d ; y++)
          for (x=0 ; x<w ; x++)
            newdata[x*(nw*nd) + z*nw + y] = data[z*(w*d) + y*w + x];
      break;
    case ORDER_ZXY:
      nw = h;   nd = w;   nh = d;
      nws = hs; nds = ws; nhs = ds;
      for (z=0 ; z<h ; z++)
        for (y=0 ; y<d ; y++)
          for (x=0 ; x<w ; x++)
            newdata[y*(nw*nd) + x*nw + z] = data[z*(w*d) + y*w + x];
      break;
    case ORDER_ZYX:
      nw = h;   nd = d;   nh = w;
      nws = hs; nds = ds; nhs = ws;
      for (z=0 ; z<h ; z++)
        for (y=0 ; y<d ; y++)
          for (x=0 ; x<w ; x++)
            newdata[x*(nw*nd) + y*nw + z] = data[z*(w*d) + y*w + x];
      break;
  } 
  free(data);
  data = newdata;
  w = nw;    d = nd;    h = nh;
  ws = nws;  ds = nds;  hs = nhs;
}

