//
// highrice.cpp
//
// Object HighRice. The 3D rectangular entities which is the result
// of subdivision of a block. It is analoguous to Padi. And it is
// child of object Padi. The detail isosurface generation is done
// here.
//
// Tien-Tsin Wong 1996
//
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "asc.h"
#include "misc.h"
#include "common.h"
#include "data.h"
#include "datatype.h"
#include "dikelign.h"
#include "padi.h"
#include "farm.h"
#include "highrice.h"


//////////////////////////// Class HighRice ///////////////////////////
// Notice the notation change, from left to right, we call +ve X,
// From near to far, we call +ve Z. From bottom to top, we call +ve Y.
void HighRice::Init(int x, int y, int b, int t)
{
#ifdef SECURITY
  if (x<1 || x>=SIZE || y<1 || y>=SIZE || b<0 || b>=N || t<0 || t>=N)
  {
    ERRMSG("[HighRice::Init]: invalid input value\n");
    return;
  }
#endif
  dike[TOP] = dike[BOTTOM] = x;
  dike[RIGHT] = dike[LEFT] = y;
  bottom = MIN(b,t);
  top = MAX(b,t);
  empty = FALSE;
}


// Check whether this highrice is enclosed by encloser.
// We consider a enclose b even if a==b.
int HighRice::EnclosedByQ(HighRice *encloser)
{
#ifdef SECURITY
  if (encloser==NULL)
  {
    ERRMSG("[HighRice::EncloseByQ]: invalid input valie\n");
    return FALSE;
  }
#endif
  if (encloser->bottom > bottom || encloser->top < top)
    return FALSE;  // check along Z direction
  return Padi::EnclosedByQ(encloser);
}


// Check whether this highrice overlaps with input highrice
int HighRice::OverlapQ(HighRice *highrice)
{
#ifdef SECURITY
  if (highrice==NULL)
  {
    ERRMSG("[HighRice::OverlapQ]: invalid input value\n");
    return FALSE;
  }
#endif
  if (highrice->top < bottom || highrice->bottom > top)
    return FALSE;  // check along Z direction
  return Padi::OverlapQ(highrice);
}


void HighRice::ClipBy(HighRice *clipper, HighRice **holder, int &cnt)
{
#ifdef SECURITY
  if (clipper==NULL || holder==NULL || cnt<0)
  {
    ERRMSG("[HighRice::ClipBy]: invalid input value\n");
    return;
  }
#endif
  Padi *padiholder[N*N];
  int padicnt, i, upperbnd, lowerbnd;
  // Cut along Z direction
  upperbnd = top;
  lowerbnd = bottom;
  if (top > clipper->top)
  {
    if ((holder[cnt] = new HighRice)==NULL)
      ERREXIT ("[HighRice::ClipBy]: no memory for holder[]\n");
    holder[cnt]->Init(dike[TOP], dike[RIGHT], clipper->top+1, top);
    cnt++;
    upperbnd = clipper->top;
  }
  if (bottom < clipper->bottom)
  {
    if ((holder[cnt] = new HighRice)==NULL)
      ERREXIT ("[HighRice::ClipBy]: no memory for holder[]\n");
    holder[cnt]->Init(dike[TOP], dike[RIGHT], bottom, clipper->bottom-1);
    cnt++;
    lowerbnd = clipper->bottom;
  }

  // Now only the same interval along z need to be clipped
  padicnt=0;
  Padi::ClipBy(clipper, padiholder, padicnt);
  for (i=0 ; i<padicnt ; i++) // for each 2D clipped padi, generate a highrice
  {
    if ((holder[cnt] = new HighRice)==NULL)
      ERREXIT ("[HighRice::ClipBy]: no memory for holder[]\n");
    holder[cnt]->Init(padiholder[i]->dike[TOP], padiholder[i]->dike[LEFT],
                      lowerbnd, upperbnd);
    cnt++;
  }
}



// setup the edgetable and
void HighRice::SetupEdgeTable(Farm *xyfarm, Farm *xzfarm, Farm *yzfarm, int *edge)
{
  int i, j, k, ytop, ybottom, xdike, occcnt;
  int edgecnt, from, to;
  CHAR edgearr[4];
  DCHAR face[20];
  Padi *occupiant[N*N];
  Farm *currfarm;

  width = Length(dike[TOP]);
  depth = Length(dike[LEFT]);
  height = top - bottom + 1;
  // total no of unit edges
  edgeno = 4 * (width*depth + height*width + height*depth);
  offset[HR_BOTTOM] = 0;
  offset[HR_TOP] = width*depth*2;
  offset[HR_NEARXZ] = offset[HR_TOP] + width*depth*2;
  offset[HR_FARXZ] = offset[HR_NEARXZ] + width*height*2;
  offset[HR_NEARYZ] = offset[HR_FARXZ] + width*height*2;
  offset[HR_FARYZ] = offset[HR_NEARYZ] + depth*height*2;

  // init the input global edge table array
  for (k=0 ; k<2*edgeno ; k++)
    edge[k] = -1;

#ifdef DEBUG
  printf ("\n\nhighrice %d x %d x [%d %d]\n", dike[TOP], dike[LEFT], bottom, top);
#endif
  for (i=0 ; i<6 ; i++) // get the padis of each face of the highrice
  {
    switch (i)
    {
      case HR_BOTTOM:
        currfarm = &(xyfarm[bottom]);  strcpy(face, "bottom: ");
        ybottom = Start(dike[LEFT]);   ytop = End(dike[LEFT])-1;
        xdike = dike[TOP];             break;
      case HR_TOP:
        currfarm = &(xyfarm[top+1]);   strcpy(face, "top: ");
        ybottom = Start(dike[LEFT]);   ytop = End(dike[LEFT])-1;
        xdike = dike[TOP];             break;
      case HR_NEARXZ:
        currfarm = &(xzfarm[Start(dike[LEFT])]);   strcpy(face, "near xz: ");
        ybottom = bottom;              ytop = top;
        xdike = dike[TOP];             break;
      case HR_FARXZ:
        currfarm = &(xzfarm[End(dike[LEFT])]);   strcpy(face, "far xz: ");
        ybottom = bottom;              ytop = top;
        xdike = dike[TOP];             break;
      case HR_NEARYZ:
        currfarm = &(yzfarm[Start(dike[TOP])]);   strcpy(face, "near yz: ");
        ybottom = bottom;              ytop = top;
        xdike = dike[LEFT];            break;
      case HR_FARYZ:
        currfarm = &(yzfarm[End(dike[TOP])]);   strcpy(face, "far yz: ");
        ybottom = bottom;              ytop = top;
        xdike = dike[LEFT];            break;
    }

    occcnt = 0;
    for (j=ybottom ; j<=ytop ; j++)  // find occupiant of current face
      currfarm->xstrip[j].UsedBy(xdike, occupiant, occcnt);

    for (j=0 ; j<occcnt ; j++) // for each occupy padi
    {
      if (Start(occupiant[j]->dike[TOP]) < Start(xdike)
      ||  End(occupiant[j]->dike[TOP])>End(xdike)
      ||  Start(occupiant[j]->dike[LEFT])<ybottom
      ||  End(occupiant[j]->dike[LEFT])-1>ytop)
        printf ("vvvvvvvvvvvvvvv padi out of highrice face bound\n");
#ifdef DEBUG
      printf ("%s %d x %d\n", face, occupiant[j]->dike[TOP], occupiant[j]->dike[LEFT]);
#endif

      edgecnt=0;
      occupiant[j]->GenEdge(edgearr, edgecnt); // find the edges on each padi
      for (k=0 ; k<edgecnt ; k+=2)
      {
        from = MapToEdgeTable(i, currfarm, occupiant[j], edgearr[k]);
        to = MapToEdgeTable(i, currfarm, occupiant[j], edgearr[k+1]);
        if (from<0 || to<0 || from>=edgeno || to>=edgeno)
          printf("[HighRice::SetupEdgeTable]: map to wrong index %d to %d (edgeno=%d)\n", from, to, edgeno);
        // duplicate 2 edge in opposite direction and fill up the double
        // sized array
        // Since I find that the edge generated may not be consistent
        // chained together, I use an algorithm tosolve this problem.
        // All edges are duplicated in reversed direction
        // i.e. if there is edge k->l then duplicated an edge from
        // l->k. Fill the edge table kth entry by l and (l+edgeno)th
        // entry by k. Hence we need an array of size 2*edgeno.
        // When finish filling, search the first nonnegative element
        // and mark it as the first node in the loop and start looping
        // if edge[curr] != prev
        //   curr = edge[curr]
        // else
        //   curr = edge[curr+edgeno]
        if (edge[from]==-1)
          edge[from] = to;
        else if (edge[edgeno+from]==-1)
          edge[edgeno+from] = to;
        else // unexpected array full
          printf ("[HighRice::SetupEdgeTable]: edge collide %d -> %d\n", from, to);
        if (edge[to]==-1)
          edge[to] = from;
        else if (edge[edgeno+to]==-1)
          edge[edgeno+to] = from;
        else // unexpected array full
          printf ("[HighRice::SetupEdgeTable]: doubled edge collide %d -> %d\n", to, from);

#ifdef DEBUG
        DCHAR fromstr[20], tostr[20];
        SIDETONAME(edgearr[k], fromstr);
        SIDETONAME(edgearr[k+1], tostr);
        printf ("edge: from %s to %s\n", fromstr, tostr);
#endif
      }
#ifdef DEBUG
      printf ("\nedge table arr:\n");
      for (k=0 ; k<2*edgeno ; k++)
        printf ("%d ", edge[k]);
      printf ("\n\n");
#endif
    }
  }
}



int HighRice::MapToEdgeTable(CHAR face, Farm *farm, Padi *padi, CHAR side)
{
#ifdef SECURITY
  if (face<0 || face>=6 || farm==NULL || padi==NULL || side<0 || side>=4)
  {
    ERRMSG("[HighRice::MapToEdgeTable]: invalid input value\n");
    return 0;
  }
#endif
  int index, fy, fx, intersect;
  SIMPLEDT *ver;
  CHAR horiz;

  // take appropiate coordinate relative to the farm's origin
  switch (side)
  {
    case BOTTOM: fx=Start(padi->dike[TOP]); fy=Start(padi->dike[LEFT]); break;
    case TOP:    fx=Start(padi->dike[TOP]); fy=End(padi->dike[LEFT]);   break;
    case LEFT:   fx=Start(padi->dike[TOP]); fy=Start(padi->dike[LEFT]); break;
    case RIGHT:  fx=End(padi->dike[TOP]);   fy=Start(padi->dike[LEFT]); break;
  }
  horiz = side==TOP || side==BOTTOM;
  if (horiz) // horizontal relative to the farm
    ver = farm->xlign[fy].ver;
  else
    ver = farm->ylign[fx].ver;
  if ((intersect=ver[padi->dike[side]])==0)  // no intersection
  {
    ERRMSG("[HighRice::MaptoEdgeTable]: input padi side has no intersection\n");
    return -1;
  }
  if (horiz)
    fx = intersect-N;
  else
    fy = intersect-N;

  switch(face)
  {
    case HR_BOTTOM:
      fx -= Start(dike[TOP]);      fy -= Start(dike[LEFT]);  // transform to highrice face's coordinate
      if (horiz) // horizontal edge fill the even entries
        if (fy==0)  // pass to HR_NEARXZ
          index = offset[HR_NEARXZ] + 2*(fx);
        else
          index = offset[HR_BOTTOM] + 2*((fy-1)*width + fx);
      else  // vertical edges fill the odd entries
        if (fx==0) // pass to HR_NEARYZ and side become horizontal
          index = offset[HR_NEARYZ] + 2*(fy);
        else
          index = offset[HR_BOTTOM] + 2*(fy*width + (fx-1)) + 1;
      break;

    case HR_TOP:
      fx -= Start(dike[TOP]);       fy -= Start(dike[LEFT]);
      if (horiz)
        if (fy==depth)  // pass to HR_FARXZ
          index = offset[HR_FARXZ] + 2*((height-1)*width + fx);
        else
          index = offset[HR_TOP]   + 2*(fy*width + fx);
      else
        if (fx==width) // pass to HR_FARYZ and side become horizontal
          index = offset[HR_FARYZ] + 2*((height-1)*depth + fy);
        else
          index = offset[HR_TOP]   + 2*(fy*width + fx) + 1;
      break;

    case HR_NEARXZ:
      fx -= Start(dike[TOP]);        fy -= bottom;
      if (horiz)
        if (fy==height)  // pass to HR_TOP
          index = offset[HR_TOP]    + 2*(fx);
        else
          index = offset[HR_NEARXZ] + 2*(fy*width + fx);
      else
        if (fx==width) //pass to HR_FARYZ
          index = offset[HR_FARYZ]  + 2*(fy*depth) + 1;
        else
          index = offset[HR_NEARXZ] + 2*(fy*width + fx) + 1;
      break;

    case HR_FARXZ:
      fx -= Start(dike[TOP]);         fy -= bottom;
      if (horiz)
        if (fy==0)  // pass to HR_BOTTOM
          index = offset[HR_BOTTOM] + 2*((depth-1)*width + fx);
        else
          index = offset[HR_FARXZ]  + 2*((fy-1)*width + fx);
      else
        if (fx==0) // pass to HR_NEARYZ
          index = offset[HR_NEARYZ] + 2*(fy*depth + depth-1) + 1;
        else
          index = offset[HR_FARXZ]  + 2*(fy*width + fx-1) + 1;
      break;

    case HR_NEARYZ:
      fx -= Start(dike[LEFT]);        fy -= bottom;
      if (horiz)
        if (fy==height)  // pass to HR_TOP  and side become vertical
          index = offset[HR_TOP]    + 2*(fx*width) + 1;
        else
          index = offset[HR_NEARYZ] + 2*(fy*depth + fx);
      else
        if (fx==0) // pass to HR_NEARXZ
          index = offset[HR_NEARXZ] + 2*(fy*width) + 1;
        else
          index = offset[HR_NEARYZ] + 2*(fy*depth + fx-1) + 1;
      break;

    case HR_FARYZ:
      fx -= Start(dike[LEFT]);        fy -= bottom;
      if (horiz)
        if (fy==0)  // pass to HR_BOTTOM and side become vertical
          index = offset[HR_BOTTOM] + 2*(fx*width + width-1) + 1;
        else
          index = offset[HR_FARYZ]  + 2*((fy-1)*depth + fx);
      else
        if (fx==depth) // pass to HR_FARXZ
          index = offset[HR_FARXZ]  + 2*(fy*width + width-1) + 1;
        else
          index = offset[HR_FARYZ]  + 2*(fy*depth + fx) + 1;
  }
  return index;
}



void HighRice::GeneratePath(int *path, int *pathcnt, int &pathno, int *edge)
{
  int i, start, nextidx, previdx, cnt;
  start = 0;

  pathno = 0;
  cnt = 0;
  while (start<edgeno) // find all the loop
  {
    for (; start<edgeno ; start++)
      if (edge[start]>=0)
        break;
    if (start>=edgeno)
      break;
    i=start;
    previdx=-1;
#ifdef DEBUG
    printf ("\n%d ", i);
#endif
    pathcnt[pathno] = 0;
    path[cnt++] = start;
    pathcnt[pathno]++;
    while (TRUE)
    {
      if (edge[i]!=previdx)  // go on to next node and mark it as read i.e. -ve
      {  nextidx = edge[i];  edge[i] -= edgeno+1;  edge[i+edgeno] -= edgeno+1; }
      else
      {  nextidx = edge[i+edgeno];  edge[i] -= edgeno+1;  edge[i+edgeno] -= edgeno+1; }
      if (nextidx==start)  // the loop is completed
        break;
      if (nextidx>=0)
      {
#ifdef DEBUG
        printf ("-> %d ", nextidx);
#endif
        path[cnt] = nextidx;  // record it in an array
        cnt++;
        pathcnt[pathno]++;
        if (cnt>edgeno || pathno>8)
          ERREXIT("[HighRice::GeneratePath]: not enough memory allocated\n");
      }
      else
      {
        ERRMSG ("[HighRice::GeneratePath]: edge loop not complete!!\n");
        return;
      }
      previdx = i;
      i = nextidx;
    }
    pathno++;
  }
}



// map the edge table index to the coordinate relative to the block
// the coordinate is described by the
// xyz       Indicates the edge is along x, y or z direction
// coord[0]  The x y and z coordinates of the bottom left near xz
// coord[1]  corner of the unit cube which the edge belong to.
// coord[2]  Note that each cube hold 3 edges
//     z     which are
//      |  / y
//      |/___ x
void HighRice::IndexToCoord(int idx, int *coord, CHAR &xyz)
{
#ifdef SECURITY
  if (idx<0 || idx>=edgeno || coord==NULL)
  {
    ERRMSG("[HighRice::IndexToCoord]: invalid input value\n");
    return;
  }
#endif
  int face;
  CHAR vertical;
  for (face=0 ; face<5 ; face++)
    if (idx>=offset[face] && idx<offset[face+1])
      break;
  idx -= offset[face];
  vertical = idx&0x01;
  idx >>= 1;
  switch (face)
  {
    case HR_BOTTOM:
      xyz = (vertical)? YDIM : XDIM;
      coord[0] = (vertical)? idx%width+1 + Start(dike[TOP]) : idx%width + Start(dike[TOP]);
      coord[1] = (vertical)? idx/width + Start(dike[LEFT])  : idx/width+1 + Start(dike[LEFT]);
      coord[2] = bottom;
      break;

    case HR_TOP:
      xyz = (vertical)? YDIM : XDIM;
      coord[0] = idx%width + Start(dike[TOP]);
      coord[1] = idx/width + Start(dike[LEFT]);
      coord[2] = top+1;
      break;

    case HR_NEARXZ:
      xyz = (vertical)? ZDIM : XDIM;
      coord[0] = idx%width + Start(dike[TOP]);
      coord[1] = Start(dike[LEFT]);
      coord[2] = idx/width + bottom;
      break;

    case HR_FARXZ:
      xyz = (vertical)? ZDIM : XDIM;
      coord[0] = (vertical)? idx%width+1 + Start(dike[TOP]) : idx%width + Start(dike[TOP]);
      coord[1] = End(dike[LEFT]);
      coord[2] = (vertical)? idx/width + bottom : idx/width+1 + bottom;
      break;

    case HR_NEARYZ:
      xyz = (vertical)? ZDIM : YDIM;
      coord[0] = Start(dike[TOP]);
      coord[1] = (vertical)? idx%depth+1 + Start(dike[LEFT]) : idx%depth + Start(dike[LEFT]);
      coord[2] = idx/depth + bottom;
      break;

    case HR_FARYZ:
      xyz = (vertical)? ZDIM : YDIM;
      coord[0] = End(dike[TOP]);
      coord[1] = idx%depth + Start(dike[LEFT]);
      coord[2] = (vertical)? idx/depth + bottom : idx/depth+1 + bottom;
      break;
  }
}


CHAR HighRice::CheckEmpty(Farm *xyfarm)
{
  int sx, sy, ex, ey;
  Farm *farm;
  register int i;
  register UCHAR occupied=0;
  sx = Start(dike[TOP]);
  ex = End(dike[TOP]);
  sy = dike[LEFT];
  ey = End(dike[LEFT]);
  for (i=bottom ; i<=top+1 ; i++)
  {
    farm = &(xyfarm[i]);
    occupied |=   farm->xlign[sy].occ[1] | farm->xlign[ey].occ[1] 
                | farm->ylign[sx].occ[1] | farm->ylign[ex].occ[1];
  }
  if (occupied)
  {
    UnsetEmpty();
    return FALSE;
  }
  else
  {
    SetEmpty();
    return TRUE;
  }
}


/********************************************************
 * output the 3D highrices as a intermediate format for
 * external program to process and display the highrices
 * interactively.
 ********************************************************/
void Out3DHighRice(VOXELDT *data1, Farm *farm, DoublyList *highricelist,
                   int offx, int offy, int offz, int datadimx,
                   int datadimy, int datadimz)
{
#ifdef SECURITY
  if (data1==NULL || farm==NULL || highricelist==NULL)
  {
    ERRMSG("[Out3DHighRice]: invalid input value\n");
    return;
  }
#endif
  int i, j, k, dim[3];
  HighRice *currhrice;
  CHAR xis, yis, zis;

  // Output the HighRice dimension
  printf ("Highrice start\n");
  for (currhrice=(HighRice*)highricelist->First() ; currhrice!=NULL ; currhrice=(HighRice*)highricelist->Next())
    printf ("%d %d %d %d\n", currhrice->dike[TOP], currhrice->dike[LEFT],
            currhrice->bottom, currhrice->top);

  // Draw the data point
  printf ("Data start\n");
  xis = farm[0].XisV();
  yis = farm[0].YisV();
  zis = 3 & (~(xis|yis));
  dim[zis] = 0;
  dim[xis] = -1;
  dim[yis] = 0;
  Data data(data1, dim[0], dim[1], dim[2], offx, offy, offz, datadimx, datadimy, datadimz);
  // Use the correct orientation to output the data point
  for (k=0 ; k<N+1 ; k++)
  {
    dim[zis]=k; // advance z
    for (j=0 ; j<N+1 ; j++)
    {
      dim[yis]=j; // advance y
      data.ReInit(data1, dim[0], dim[1], dim[2], offx, offy, offz, datadimx, datadimy, datadimz);
      for (i=0 ; i<N+1 ; i++)
        printf ("%d ", data[i]);
      printf("\n");
    }
    printf("\n");
  }
}


void HighRiceStatistic(DoublyList *highricelist)
{
#ifdef SECURITY
  if (highricelist==NULL)
  {
    ERRMSG("[HighRiceStatistic]: invalid input value\n");
    return;
  }
#endif
  int count[N*N*N], i, j, k, height, b1, b2, e1, e2;
  HighRice *highrice;

  for (i=0 ; i<N*N ; i++)
    count[i] = 0;
  for (highrice=(HighRice*)highricelist->First() ; highrice!=NULL ; highrice=(HighRice*)highricelist->Next())
  {
    height = highrice->top - highrice->bottom + 1;
    b1 = Start(highrice->dike[LEFT]);
    e1 = End(highrice->dike[LEFT]);
    b2 = Start(highrice->dike[TOP]);
    e2 = End(highrice->dike[TOP]);
    for (j=b1 ; j<e1 ; j++)
      for (i=b2 ; i<e2 ; i++)
        count[j*N+i] += height;
  }
  printf ("No of voxel occupied in each vertical highrice:\n");
  for (j=N-1 ; j>=0 ; j--)
  {
    for (i=0 ; i<N ; i++)
      printf ("%d ", count[j*N+i]);
    printf ("\n");
  }
  printf ("\n");

  // Check whether there is overlapped voxel
  printf ("Checking whether highrices overlapped\n");
  for (i=0 ; i<N*N*N ; i++)
    count[i] = 0;
  for (highrice=(HighRice*)highricelist->First() ; highrice!=NULL ; highrice=(HighRice*)highricelist->Next())
  {
    height = highrice->top - highrice->bottom + 1;
    b1 = Start(highrice->dike[LEFT]);
    e1 = End(highrice->dike[LEFT]);
    b2 = Start(highrice->dike[TOP]);
    e2 = End(highrice->dike[TOP]);
    for (k=highrice->bottom ; k<=highrice->top ; k++)
      for (j=b1 ; j<e1 ; j++)
        for (i=b2 ; i<e2 ; i++)
        {
          if (count[k*N*N+j*N+i]!=0)
            printf ("Overlap at (%d %d %d)\n", i, k, j);
          count[k*N*N+j*N+i]++;
        }
  }
  printf ("\n\n");
}



