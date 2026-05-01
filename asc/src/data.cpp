//
// data.cpp
//
// In order to hide unnecessary information from user, the user can see "only"
// 0 (below threshold) and 1 (above threshold). Of course user can look at
// at the real data value by special function.
// Moreover, the voxel is displayed to user a one dimension array of data
// along one dimension.
//
// Tien-Tsin Wong 1996
//
#include <stdlib.h>
#include <stdio.h>
#include "datatype.h"
#include "data.h"
#include "misc.h"
#include "common.h"
#include "global.h"

///////////////////////////// Class "Data" ///////////////////////////////
// INPUT PARAMETERS:
// 1) info    pointer to the 1 D array holding data 0 or 1
// 2) x       coordinate x of the data line if x>=0, if x<0, dim x is variable
// 3) y       coordinate y of the data line if y>=0, if y<0, dim y is variable
// 4) z       coordinate z of the data line if z>=0, if z<0, dim z is variable
// one of x or y or z must be <0
// 5) offx    offset add to coordinate x, ie. true x coordinate = x+offx
// 6) offy    offset add to coordinate y. ie. true y coordinate = y+offy
// 7) offz    offset add to coordinate z, ie. true z coordinate = z+offz
// 8) datadimx   Real dimension of the data grid holding in the
// 9) datadimy   1D memory array. That is datadimx*datadimy*datadimz is
// 10)datadimz   the size of the 1D array.
//
void Data::ReInit(VOXELDT *info, int x, int y, int z, int offx,
                  int offy, int offz, int datadimx, int datadimy,
                  int datadimz)
{
#ifdef SECURITY
  if (info==NULL || (x<0 && x!=-1) || (y<0 && y!=-1) || (z<0 && z!=-1)
  || offx<0 || offy<0 || offz<0)
  {
    ERRMSG("[Data::ReInit]: invalid input value\n");
    return;
  }
#endif
  content = info;
  OffX = offx;
  OffY = offy;
  OffZ = offz;
  width = datadimx;
  depth = datadimy;
  height = datadimz;
  fixedx = x+offx;
  fixedy = y+offy;
  fixedz = z+offz;
  if (fixedx>=datadimx || fixedy>=datadimy || fixedz>=datadimz)
  {
    vary = OUTBND;  // allow out of bound access, but always return 0
    return;
  }
  if (x<0)
  {
    offset = fixedz*width*depth + fixedy*width + offx;
    multiplier = -1; // since not used;
    vary = VARYX;
  }
  else if (y<0)
  {
    offset = fixedz*width*depth + offy*width + fixedx;
    multiplier = -1; // since not used
    vary = VARYY;
  }
  else if (z<0)
  {
    offset = offz*width*depth + fixedy*width + fixedx;
    multiplier = width*depth;
    vary = VARYZ;
  }
  else
    printf ("[Data::Data]: no dimension is variable\n");
}


// The reason to allow the out of bound access, is that
// not all data has a dimension which is exactly power of N
VOXELDT Data::Value(int i)
{
  switch(vary)
  {
    case VARYX:
      if (i+OffX<width)  // within bound
        return content[offset+i];
      else
        return 0;

    case VARYY:
      if (i+OffY<depth)  // within bound
        return content[offset+i*width];
      else
        return 0;

    case VARYZ:
      if (i+OffZ<height)  // within bound
        return content[offset+i*multiplier];
      else
        return 0;

    case OUTBND:
      return 0;

    default:
      ERRMSG("[Data::Value]: invalid vary type\n");
      return 0; // Error
  }
}


CHAR Data::operator[](int i)
{
  switch(vary)
  {
    case VARYX:
      if (i+OffX<width)
        return (content[offset+i]>=G_Threshold)? 1: 0;
      else
        return 0;

    case VARYY:
      if (i+OffY<depth)
        return (content[offset+i*width]>=G_Threshold)? 1: 0;
      else
        return 0;

    case VARYZ:
      if (i+OffZ<height)
        return (content[offset+i*multiplier]>=G_Threshold)? 1: 0;
      else
        return 0;

    case OUTBND:
      return 0;

    default:
      ERRMSG("[Data::operator[]]: invalid vary type\n");
      return 0; // Error
  }
}

